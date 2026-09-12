import {
  CARDMARKET_PRICE_LANES,
  CARDMARKET_SOURCE_NAME,
  buildCardmarketPriceGuideBatch,
} from './cardmarket-adapter.mjs';
import { persistMarketEvidenceBatch } from './market-store.mjs';
import { resolveVerifiedExactCardSourceMapping } from './source-mapping-resolver.mjs';

// These are Cardmarket source-mapping keys, not FateDrop canonical variants.
// A standard price-guide lane is only allowed to resolve the explicit `normal`
// Cardmarket mapping. Holo evidence remains a separate `holo` source mapping.
export const CARDMARKET_PRICE_LANE_SOURCE_VARIANTS = Object.freeze({
  standard: 'normal',
  holo: 'holo',
});

function requireStore(store) {
  if (!store || (typeof store.read !== 'function' && typeof store.pool !== 'function')) {
    throw new TypeError('Fate Value store is required');
  }
  return store;
}

function normaliseLane(lane) {
  const value = String(lane || '').trim().toLowerCase();
  if (!CARDMARKET_PRICE_LANES.includes(value)) {
    throw new TypeError(`unsupported Cardmarket price lane: ${lane}`);
  }
  return value;
}

export function sourceVariantKeyForCardmarketPriceLane(lane) {
  return CARDMARKET_PRICE_LANE_SOURCE_VARIANTS[normaliseLane(lane)];
}

export function createCardmarketDailyExactMappingResolver(store) {
  requireStore(store);
  return async ({ sourceName, sourceRecordId, priceGuideLane }) => {
    if (String(sourceName || '').trim().toLowerCase() !== CARDMARKET_SOURCE_NAME) return null;
    return resolveVerifiedExactCardSourceMapping(store, {
      sourceName: CARDMARKET_SOURCE_NAME,
      sourceRecordId,
      sourceVariantKey: sourceVariantKeyForCardmarketPriceLane(priceGuideLane),
    });
  };
}


export async function createCardmarketBatchExactMappingResolver(store, productIds) {
  requireStore(store);
  if (typeof store.read === 'function') return createCardmarketDailyExactMappingResolver(store);
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT m.id,m.card_identity_id,m.source_name,
      m.source_record_id,m.source_variant_key
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
    WHERE m.source_name='cardmarket'
      AND m.source_record_id=ANY($1::text[])
      AND m.source_variant_key IN ('normal','holo')
      AND c.verification_status='verified'`, [productIds]);
  const mappings = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.source_record_id, row.source_variant_key]);
    // Never choose the first owner when source evidence is ambiguous.
    if (mappings.has(key)) {
      mappings.set(key, null);
      continue;
    }
    mappings.set(key, Object.freeze({
      id: row.id, cardIdentityId: row.card_identity_id, sourceName: row.source_name,
      sourceRecordId: row.source_record_id, sourceVariantKey: row.source_variant_key,
    }));
  }
  return async ({ sourceName, sourceRecordId, priceGuideLane }) => {
    if (String(sourceName || '').trim().toLowerCase() !== CARDMARKET_SOURCE_NAME) return null;
    return mappings.get(JSON.stringify([
      String(sourceRecordId).trim(), sourceVariantKeyForCardmarketPriceLane(priceGuideLane),
    ])) ?? null;
  };
}

export async function prepareCardmarketDailyPriceGuideBatch({
  store,
  priceGuidePayload,
  observedAt = Date.now(),
  lanes = CARDMARKET_PRICE_LANES,
} = {}) {
  requireStore(store);
  if (!priceGuidePayload || typeof priceGuidePayload !== 'object' || Array.isArray(priceGuidePayload)) {
    throw new TypeError('Cardmarket priceGuidePayload is required');
  }

  return buildCardmarketPriceGuideBatch(priceGuidePayload, {
    observedAt,
    lanes,
    resolveMapping: await createCardmarketBatchExactMappingResolver(store,
      [...new Set((priceGuidePayload.priceGuides || []).map(row => String(row?.idProduct ?? '')))]),
  });
}

export async function ingestCardmarketDailyPriceGuide(options = {}) {
  const store = requireStore(options.store);
  const batch = await prepareCardmarketDailyPriceGuideBatch(options);
  const persistence = await persistMarketEvidenceBatch(store, batch);

  return Object.freeze({
    sourceName: batch.snapshot.sourceName,
    sourceSnapshotId: batch.snapshot.sourceSnapshotId,
    sourceEffectiveAt: batch.snapshot.sourceEffectiveAt,
    sourceCurrency: batch.snapshot.currencyCode,
    status: batch.run.status,
    recordsSeen: batch.run.recordsSeen,
    recordsAccepted: batch.run.recordsAccepted,
    recordsRejected: batch.run.recordsRejected,
    insertedObservations: persistence.insertedObservations,
    duplicateObservations: persistence.duplicateObservations,
    insertedRejections: persistence.insertedRejections,
  });
}
