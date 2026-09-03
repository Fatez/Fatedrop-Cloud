import { resolveFatePrice } from './fate-price.mjs';
import { enrichMarketObservationsWithProviderPolicy } from './price-provenance.mjs';

const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const POSTGRES_OBSERVATIONS_PER_CARD = 8;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function currency(value) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currencyCode must be a 3-letter currency code');
  return code;
}

function timestamp(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${field} must be a positive timestamp`);
  return number;
}

function positiveDuration(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${field} must be positive`);
  return number;
}

function uniqueIds(values) {
  if (!Array.isArray(values)) throw new TypeError('cardIdentityIds must be an array');
  return Object.freeze([...new Set(values.map(text).filter(Boolean))]);
}

function effectiveAt(row) {
  const raw = row?.sourceEffectiveAt ?? row?.observedAt;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function postgresObservation(row) {
  return Object.freeze({
    id: row.id,
    ingestRunId: row.ingest_run_id,
    cardIdentityId: row.card_identity_id,
    cardSourceMappingId: row.card_source_mapping_id,
    sourceName: row.source_name,
    sourceSnapshotId: row.source_snapshot_id,
    sourceRecordId: row.source_record_id,
    sourceVariantKey: row.source_variant_key,
    marketSegmentKey: row.market_segment_key,
    conditionCode: row.condition_code,
    currencyCode: row.currency_code,
    observedAt: row.observed_at == null ? null : Number(row.observed_at),
    sourceEffectiveAt: row.source_effective_at == null ? null : Number(row.source_effective_at),
    marketDay: row.market_day instanceof Date ? row.market_day.toISOString().slice(0, 10) : String(row.market_day ?? ''),
    marketPrice: row.market_price,
    lowPrice: row.low_price,
    trendPrice: row.trend_price,
    avg1d: row.avg_1d,
    avg7d: row.avg_7d,
    avg30d: row.avg_30d,
    avgLifetime: row.avg_lifetime,
    excellentPlusLow: row.excellent_plus_low,
  });
}

function postgresRun(row) {
  return Object.freeze({
    id: row.run_id,
    sourceName: row.run_source_name,
    sourceSnapshotId: row.run_source_snapshot_id,
    metadataJson: row.run_metadata_json ?? {},
  });
}

async function loadFileEvidence(store, cardIdentityIds, currencyCode, asOf) {
  const state = await store.read();
  const cardIds = new Set(cardIdentityIds);
  const observations = Object.values(state?.fateValueLab?.observations || {})
    .filter((row) => cardIds.has(text(row?.cardIdentityId)))
    .filter((row) => text(row?.currencyCode).toUpperCase() === currencyCode)
    .filter((row) => {
      const at = effectiveAt(row);
      return at == null || at <= asOf;
    });
  const ingestRuns = Object.values(state?.fateValueLab?.ingestRuns || {});
  return Object.freeze({
    evidenceSourceType: 'file',
    schemaAvailable: true,
    observations: Object.freeze(observations),
    ingestRuns: Object.freeze(ingestRuns),
  });
}

async function loadPostgresEvidence(store, cardIdentityIds, currencyCode, asOf) {
  const pool = await store.pool();
  try {
    const { rows } = await pool.query(
      `WITH ranked AS (
         SELECT o.id,o.ingest_run_id,o.card_identity_id,o.card_source_mapping_id,
                o.source_name,o.source_snapshot_id,o.source_record_id,o.source_variant_key,
                o.market_segment_key,o.condition_code,o.currency_code,o.observed_at,
                o.source_effective_at,o.market_day,o.market_price,o.low_price,o.trend_price,
                o.avg_1d,o.avg_7d,o.avg_30d,o.avg_lifetime,o.excellent_plus_low,
                r.id AS run_id,r.source_name AS run_source_name,
                r.source_snapshot_id AS run_source_snapshot_id,r.metadata_json AS run_metadata_json,
                ROW_NUMBER() OVER (
                  PARTITION BY o.card_identity_id
                  ORDER BY COALESCE(o.source_effective_at,o.observed_at) DESC,o.observed_at DESC,o.id DESC
                ) AS rn
           FROM fatedrop_market_observations o
           JOIN fatedrop_market_ingest_runs r ON r.id=o.ingest_run_id
          WHERE o.card_identity_id = ANY($1::text[])
            AND o.currency_code=$2
            AND COALESCE(o.source_effective_at,o.observed_at) <= $3
       )
       SELECT * FROM ranked WHERE rn <= $4
       ORDER BY card_identity_id,COALESCE(source_effective_at,observed_at) DESC,observed_at DESC,id DESC`,
      [cardIdentityIds, currencyCode, asOf, POSTGRES_OBSERVATIONS_PER_CARD],
    );

    const observations = [];
    const runsById = new Map();
    for (const row of rows) {
      observations.push(postgresObservation(row));
      const run = postgresRun(row);
      if (run.id) runsById.set(run.id, run);
    }

    return Object.freeze({
      evidenceSourceType: 'postgres',
      schemaAvailable: true,
      observations: Object.freeze(observations),
      ingestRuns: Object.freeze([...runsById.values()]),
    });
  } catch (error) {
    if (error?.code === '42P01') {
      return Object.freeze({
        evidenceSourceType: 'postgres',
        schemaAvailable: false,
        observations: Object.freeze([]),
        ingestRuns: Object.freeze([]),
      });
    }
    throw error;
  }
}

async function loadEvidence(store, cardIdentityIds, currencyCode, asOf) {
  if (typeof store?.read === 'function') return loadFileEvidence(store, cardIdentityIds, currencyCode, asOf);
  if (typeof store?.pool === 'function') return loadPostgresEvidence(store, cardIdentityIds, currencyCode, asOf);
  throw new Error('Fate Price evidence store is unavailable');
}

function unavailablePrice(cardIdentityId, currencyCode, reason) {
  return Object.freeze({
    status: 'unavailable',
    reason,
    valuationKind: 'raw-market',
    cardIdentityId,
    amount: null,
    currencyCode,
  });
}

export async function loadFatePricesFromStore(store, {
  cardIdentityIds,
  currencyCode,
  asOf = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const ids = uniqueIds(cardIdentityIds);
  const code = currency(currencyCode);
  const effectiveAsOf = timestamp(asOf, 'asOf');
  const effectiveMaxAgeMs = positiveDuration(maxAgeMs, 'maxAgeMs');

  if (ids.length === 0) {
    return Object.freeze({
      status: 'available',
      reason: null,
      currencyCode: code,
      asOf: effectiveAsOf,
      requestedCardCount: 0,
      availablePriceCount: 0,
      unavailablePriceCount: 0,
      rejectedProvenanceCount: 0,
      evidenceSourceType: null,
      prices: Object.freeze([]),
    });
  }

  const evidence = await loadEvidence(store, ids, code, effectiveAsOf);
  if (!evidence.schemaAvailable) {
    return Object.freeze({
      status: 'building',
      reason: 'market_history_schema_missing',
      currencyCode: code,
      asOf: effectiveAsOf,
      requestedCardCount: ids.length,
      availablePriceCount: 0,
      unavailablePriceCount: ids.length,
      rejectedProvenanceCount: 0,
      evidenceSourceType: evidence.evidenceSourceType,
      prices: Object.freeze(ids.map((id) => unavailablePrice(id, code, 'market_history_schema_missing'))),
    });
  }

  const provenance = enrichMarketObservationsWithProviderPolicy({
    observations: evidence.observations,
    ingestRuns: evidence.ingestRuns,
  });
  const prices = ids.map((cardIdentityId) => resolveFatePrice({
    cardIdentityId,
    observations: provenance.observations,
    currencyCode: code,
    asOf: effectiveAsOf,
    maxAgeMs: effectiveMaxAgeMs,
  }));
  const availablePriceCount = prices.filter((price) => price.status === 'available').length;
  const unavailablePriceCount = ids.length - availablePriceCount;

  return Object.freeze({
    status: availablePriceCount === ids.length ? 'available' : availablePriceCount > 0 ? 'partial' : 'unavailable',
    reason: availablePriceCount === ids.length ? null : availablePriceCount > 0 ? 'price_coverage_incomplete' : 'no_current_approved_price_evidence',
    currencyCode: code,
    asOf: effectiveAsOf,
    requestedCardCount: ids.length,
    availablePriceCount,
    unavailablePriceCount,
    rejectedProvenanceCount: provenance.rejected.length,
    evidenceSourceType: evidence.evidenceSourceType,
    prices: Object.freeze(prices),
  });
}
