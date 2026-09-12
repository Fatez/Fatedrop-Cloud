import {
  CARDMARKET_PRICE_LANES,
  CARDMARKET_SOURCE_NAME,
  buildCardmarketPriceGuideBatch,
  hasMeaningfulCardmarketLane,
} from './cardmarket-adapter.mjs';
import {
  CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS,
  isAuditedInherentHoloBaseLaneProduct,
} from './cardmarket-inherent-holo-base-lane-policy.mjs';
import { validateAuditedInherentHoloMappingChunks } from './cardmarket-inherent-holo-base-lane-integrity.mjs';
import { persistMarketEvidenceBatch } from './market-store.mjs';
import { resolveVerifiedExactCardSourceMapping } from './source-mapping-resolver.mjs';

// Cardmarket mapping keys stay exact. Provider numeric-lane interpretation is
// handled separately by the adapter so a holo identity can consume an audited
// base-lane price without ever becoming a FateDrop `standard` market segment.
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

function normaliseProductIdSet(values) {
  return new Set([...(values || [])].map((value) => String(value ?? '').trim()).filter(Boolean));
}

function mappingKey(sourceRecordId, sourceVariantKey) {
  return JSON.stringify([String(sourceRecordId).trim(), String(sourceVariantKey).trim()]);
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

export function collectCurrentGuideInherentHoloBaseLaneEligibleProductIds(priceGuidePayload) {
  const eligible = new Set();
  for (const row of priceGuidePayload?.priceGuides || []) {
    const sourceRecordId = String(row?.idProduct ?? '').trim();
    if (!sourceRecordId || !isAuditedInherentHoloBaseLaneProduct(sourceRecordId)) continue;
    if (!hasMeaningfulCardmarketLane(row, 'standard')) continue;
    if (hasMeaningfulCardmarketLane(row, 'holo')) continue;
    eligible.add(sourceRecordId);
  }
  return eligible;
}

export function resolveCardmarketBatchMapping({
  mappings,
  sourceName,
  sourceRecordId,
  priceGuideLane,
} = {}) {
  if (String(sourceName || '').trim().toLowerCase() !== CARDMARKET_SOURCE_NAME) return null;
  const productId = String(sourceRecordId ?? '').trim();
  const lane = normaliseLane(priceGuideLane);
  const exactVariant = sourceVariantKeyForCardmarketPriceLane(lane);
  const exactKey = mappingKey(productId, exactVariant);

  // Exact ownership only. A present-but-null entry means duplicate ownership
  // was detected and deliberately remains fail-closed.
  return mappings.has(exactKey) ? mappings.get(exactKey) : null;
}

export async function createCardmarketBatchExactMappingResolution(store, productIds, {
  inherentHoloBaseLaneEligibleProductIds = new Set(),
} = {}) {
  requireStore(store);

  // File-backed/test stores do not expose the production-wide mapping rows
  // required to prove the frozen audit digests. Keep exact matching available,
  // but disable the exceptional provider-lane interpretation fail-closed.
  if (typeof store.read === 'function') {
    return Object.freeze({
      resolveMapping: createCardmarketDailyExactMappingResolver(store),
      inherentHoloBaseLaneProductIds: new Set(),
    });
  }

  const requestedProductIds = normaliseProductIdSet(productIds);
  const eligibleInherentHoloProductIds = normaliseProductIdSet(inherentHoloBaseLaneEligibleProductIds);
  const queryProductIds = [...new Set([
    ...requestedProductIds,
    ...CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS,
  ])];

  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT m.id,m.card_identity_id,m.source_name,
      m.source_record_id,m.source_variant_key,c.variant_code AS canonical_variant_code
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
    WHERE m.source_name='cardmarket'
      AND m.source_record_id=ANY($1::text[])
      AND m.source_variant_key IN ('normal','holo')
      AND c.verification_status='verified'`, [queryProductIds]);

  const mappings = new Map();
  for (const row of rows) {
    const key = mappingKey(row.source_record_id, row.source_variant_key);
    // Never choose the first owner when source evidence is ambiguous.
    if (mappings.has(key)) {
      mappings.set(key, null);
      continue;
    }
    mappings.set(key, Object.freeze({
      id: row.id,
      cardIdentityId: row.card_identity_id,
      sourceName: row.source_name,
      sourceRecordId: row.source_record_id,
      sourceVariantKey: row.source_variant_key,
    }));
  }

  const integrity = validateAuditedInherentHoloMappingChunks(rows);
  const inherentHoloBaseLaneProductIds = new Set(
    [...eligibleInherentHoloProductIds].filter((productId) => (
      integrity.validProductIds.has(productId)
      && mappings.has(mappingKey(productId, 'holo'))
      && mappings.get(mappingKey(productId, 'holo')) != null
      && !mappings.has(mappingKey(productId, 'normal'))
    )),
  );

  const resolveMapping = async ({ sourceName, sourceRecordId, priceGuideLane }) => (
    resolveCardmarketBatchMapping({
      mappings,
      sourceName,
      sourceRecordId,
      priceGuideLane,
    })
  );

  return Object.freeze({
    resolveMapping,
    inherentHoloBaseLaneProductIds,
  });
}

export async function createCardmarketBatchExactMappingResolver(store, productIds, options = {}) {
  const resolution = await createCardmarketBatchExactMappingResolution(store, productIds, options);
  return resolution.resolveMapping;
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

  const productIds = [...new Set((priceGuidePayload.priceGuides || []).map(
    (row) => String(row?.idProduct ?? ''),
  ))];
  const inherentHoloBaseLaneEligibleProductIds = collectCurrentGuideInherentHoloBaseLaneEligibleProductIds(
    priceGuidePayload,
  );
  const resolution = await createCardmarketBatchExactMappingResolution(store, productIds, {
    inherentHoloBaseLaneEligibleProductIds,
  });

  return buildCardmarketPriceGuideBatch(priceGuidePayload, {
    observedAt,
    lanes,
    resolveMapping: resolution.resolveMapping,
    inherentHoloBaseLaneProductIds: resolution.inherentHoloBaseLaneProductIds,
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
