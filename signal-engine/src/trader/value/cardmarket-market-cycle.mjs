import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';
import { persistMarketEvidenceBatch } from './market-store.mjs';
import { buildMarketDataReadinessReport } from './market-data-readiness.mjs';

const MODES = new Set(['dry-run', 'persist']);

function modeValue(value) {
  const mode = String(value || 'dry-run').trim().toLowerCase();
  if (!MODES.has(mode)) throw new TypeError('mode must be dry-run or persist');
  return mode;
}

function artifactSummary(artifact) {
  return Object.freeze({
    url: artifact.url,
    fetchedAt: artifact.fetchedAt,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    etag: artifact.etag,
    lastModified: artifact.lastModified,
  });
}

export async function listVerifiedNormalCardmarketProductIds(store) {
  if (!store || (typeof store.read !== 'function' && typeof store.pool !== 'function')) {
    throw new TypeError('Fate Value store is required');
  }

  if (typeof store.read === 'function') {
    const state = await store.read();
    const catalogue = state?.traderCatalogue;
    if (!catalogue) return new Set();
    const cards = catalogue.cards || {};
    return new Set(Object.values(catalogue.cardSourceMappings || {})
      .filter((mapping) => mapping?.sourceName === 'cardmarket' && mapping?.sourceVariantKey === 'normal')
      .filter((mapping) => cards[mapping.cardIdentityId]?.verificationStatus === 'verified')
      .map((mapping) => String(mapping.sourceRecordId)));
  }

  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT DISTINCT m.source_record_id
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
    WHERE m.source_name='cardmarket'
      AND m.source_variant_key='normal'
      AND c.verification_status='verified'`);
  return new Set(rows.map((row) => String(row.source_record_id)));
}

export function scopeCardmarketPriceGuideToMappedProducts(payload, productIds) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Cardmarket priceGuidePayload is required');
  }
  if (!(productIds instanceof Set)) throw new TypeError('productIds must be a Set');
  const priceGuides = Array.isArray(payload.priceGuides) ? payload.priceGuides : [];
  return Object.freeze({
    ...payload,
    priceGuides: priceGuides.filter((row) => productIds.has(String(row?.idProduct ?? ''))),
  });
}

export async function runCardmarketPokemonMarketCycle({
  store,
  mode = 'dry-run',
  fetchedAt = Date.now(),
  observedAt = fetchedAt,
  fetchImpl = globalThis.fetch,
  sourceUrl,
  maxAgeMs,
  futureSkewMs,
  timeoutMs,
  maxBytes,
} = {}) {
  const selectedMode = modeValue(mode);
  if (!store || (typeof store.read !== 'function' && typeof store.pool !== 'function')) {
    throw new TypeError('Fate Value store is required');
  }

  const source = await fetchCardmarketPokemonPriceGuide({
    ...(sourceUrl ? { url: sourceUrl } : {}),
    fetchImpl,
    fetchedAt,
    ...(maxAgeMs == null ? {} : { maxAgeMs }),
    ...(futureSkewMs == null ? {} : { futureSkewMs }),
    ...(timeoutMs == null ? {} : { timeoutMs }),
    ...(maxBytes == null ? {} : { maxBytes }),
  });

  const mappedProductIds = await listVerifiedNormalCardmarketProductIds(store);
  if (!mappedProductIds.size) throw new Error('No verified Cardmarket normal mappings are available for the daily cycle');
  const scopedPayload = scopeCardmarketPriceGuideToMappedProducts(source.artifact.payload, mappedProductIds);

  const batch = await prepareCardmarketDailyPriceGuideBatch({
    store,
    priceGuidePayload: scopedPayload,
    observedAt,
    lanes: ['standard'],
  });

  let persistence = null;
  if (selectedMode === 'persist') {
    persistence = await persistMarketEvidenceBatch(store, batch);
  }

  const readiness = await buildMarketDataReadinessReport(store, { sourceName: 'cardmarket' });

  return Object.freeze({
    mode: selectedMode,
    persistenceAuthorized: selectedMode === 'persist',
    artifact: artifactSummary(source.artifact),
    sourceSnapshotId: batch.snapshot.sourceSnapshotId,
    sourceEffectiveAt: batch.snapshot.sourceEffectiveAt,
    sourceCurrency: batch.snapshot.currencyCode,
    mappedProducts: mappedProductIds.size,
    scopedPriceGuideRows: scopedPayload.priceGuides.length,
    recordsSeen: batch.run.recordsSeen,
    recordsAccepted: batch.run.recordsAccepted,
    recordsRejected: batch.run.recordsRejected,
    status: batch.run.status,
    persistence: persistence ? Object.freeze({ ...persistence }) : null,
    readiness,
  });
}
