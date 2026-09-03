import { MARKET_PULSE_PRICE_FIELDS, buildMarketPulseSnapshot } from './market-pulse.mjs';

const MAX_LOOKBACK_DAYS = 30;

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalText(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function normaliseLabel(value, fallback, field) {
  const text = optionalText(value) ?? optionalText(fallback);
  if (!text) throw new TypeError(`${field} is required`);
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '-');
}

function normaliseCurrency(value) {
  const currencyCode = requireText(value, 'currencyCode').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError('currencyCode must be an ISO-style 3-letter code');
  return currencyCode;
}

function normalisePriceField(value) {
  const priceField = requireText(value, 'priceField');
  if (!MARKET_PULSE_PRICE_FIELDS.includes(priceField)) {
    throw new TypeError(`priceField must be one of: ${MARKET_PULSE_PRICE_FIELDS.join(', ')}`);
  }
  return priceField;
}

function normaliseInput(input = {}) {
  return Object.freeze({
    sourceName: requireText(input.sourceName, 'sourceName'),
    priceField: normalisePriceField(input.priceField),
    currencyCode: normaliseCurrency(input.currencyCode),
    marketSegmentKey: normaliseLabel(input.marketSegmentKey, 'default', 'marketSegmentKey'),
    conditionCode: normaliseLabel(input.conditionCode, 'unspecified', 'conditionCode'),
    tcgCode: optionalText(input.tcgCode),
    setCode: optionalText(input.setCode),
  });
}

function normaliseMarketDay(value) {
  const text = optionalText(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return text;
}

function subtractUtcDays(day, days) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function matchesBasis(observation, basis) {
  if (!observation || typeof observation !== 'object') return false;
  return observation.sourceName === basis.sourceName
    && String(observation.currencyCode ?? '').toUpperCase() === basis.currencyCode
    && normaliseLabel(observation.marketSegmentKey, 'default', 'marketSegmentKey') === basis.marketSegmentKey
    && normaliseLabel(observation.conditionCode, 'unspecified', 'conditionCode') === basis.conditionCode;
}

function fileIdentityIndex(state) {
  const catalogue = state?.traderCatalogue || {};
  const tcgs = catalogue.tcgs || {};
  const series = catalogue.series || {};
  const sets = catalogue.sets || {};
  const printings = catalogue.printings || {};
  const identities = new Map();

  for (const card of Object.values(catalogue.cards || {})) {
    if (!card?.id || card.verificationStatus !== 'verified') continue;
    const tcg = tcgs[card.tcgId] ?? null;
    const cardSeries = series[card.seriesId] ?? null;
    const set = sets[card.setId] ?? null;
    const printing = printings[card.printingId] ?? null;
    identities.set(card.id, Object.freeze({
      id: card.id,
      fateCardId: card.id,
      name: optionalText(printing?.name),
      tcgCode: optionalText(tcg?.code),
      seriesCode: optionalText(cardSeries?.code),
      setCode: optionalText(set?.code),
      collectorNumber: optionalText(card.collectorNumber),
      variantCode: optionalText(card.variantCode),
      languageCode: optionalText(card.languageCode),
      verificationStatus: card.verificationStatus,
    }));
  }
  return identities;
}

function identityMatchesScope(identity, basis) {
  if (!identity) return false;
  if (basis.tcgCode && identity.tcgCode !== basis.tcgCode) return false;
  if (basis.setCode && identity.setCode !== basis.setCode) return false;
  return true;
}

function fileEvidence(state, basis) {
  const identities = fileIdentityIndex(state);
  const basisObservations = Object.values(state?.fateValueLab?.observations || {})
    .filter((observation) => matchesBasis(observation, basis));

  const anchorMarketDay = basisObservations
    .filter((observation) => identityMatchesScope(identities.get(observation.cardIdentityId), basis))
    .map((observation) => normaliseMarketDay(observation.marketDay))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  if (!anchorMarketDay) {
    return Object.freeze({
      sourceType: 'file',
      anchorMarketDay: null,
      observations: Object.freeze([]),
      cardIdentities: Object.freeze([...identities.values()]),
    });
  }

  const firstMarketDay = subtractUtcDays(anchorMarketDay, MAX_LOOKBACK_DAYS);
  const observations = basisObservations.filter((observation) => {
    const marketDay = normaliseMarketDay(observation.marketDay);
    return marketDay && marketDay >= firstMarketDay && marketDay <= anchorMarketDay;
  });

  return Object.freeze({
    sourceType: 'file',
    anchorMarketDay,
    observations: Object.freeze(observations),
    cardIdentities: Object.freeze([...identities.values()]),
  });
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
    marketDay: normaliseMarketDay(row.market_day instanceof Date
      ? row.market_day.toISOString().slice(0, 10)
      : String(row.market_day ?? '')),
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

function postgresIdentity(row) {
  if (row.verification_status !== 'verified') return null;
  return Object.freeze({
    id: row.card_identity_id,
    fateCardId: row.card_identity_id,
    name: optionalText(row.card_name),
    tcgCode: optionalText(row.tcg_code),
    seriesCode: optionalText(row.series_code),
    setCode: optionalText(row.set_code),
    collectorNumber: optionalText(row.collector_number),
    variantCode: optionalText(row.variant_code),
    languageCode: optionalText(row.language_code),
    verificationStatus: row.verification_status,
  });
}

async function postgresEvidence(store, basis) {
  const pool = await store.pool();
  const anchor = await pool.query(
    `SELECT MAX(o.market_day)::text AS anchor_market_day
       FROM fatedrop_market_observations o
       JOIN fatedrop_card_identities c ON c.id=o.card_identity_id
       JOIN fatedrop_tcgs t ON t.id=c.tcg_id
       JOIN fatedrop_card_sets s ON s.id=c.set_id
      WHERE o.source_name=$1
        AND o.currency_code=$2
        AND o.market_segment_key=$3
        AND o.condition_code=$4
        AND c.verification_status='verified'
        AND ($5::text IS NULL OR t.code=$5)
        AND ($6::text IS NULL OR s.code=$6)`,
    [basis.sourceName, basis.currencyCode, basis.marketSegmentKey, basis.conditionCode, basis.tcgCode, basis.setCode],
  );
  const anchorMarketDay = normaliseMarketDay(anchor.rows[0]?.anchor_market_day);
  if (!anchorMarketDay) {
    return Object.freeze({
      sourceType: 'postgres',
      anchorMarketDay: null,
      observations: Object.freeze([]),
      cardIdentities: Object.freeze([]),
    });
  }

  const { rows } = await pool.query(
    `SELECT o.id,o.ingest_run_id,o.card_identity_id,o.card_source_mapping_id,
            o.source_name,o.source_snapshot_id,o.source_record_id,o.source_variant_key,
            o.market_segment_key,o.condition_code,o.currency_code,o.observed_at,
            o.source_effective_at,o.market_day,o.market_price,o.low_price,o.trend_price,
            o.avg_1d,o.avg_7d,o.avg_30d,o.avg_lifetime,o.excellent_plus_low,
            c.collector_number,c.variant_code,c.language_code,c.verification_status,
            t.code AS tcg_code,cs.code AS series_code,s.code AS set_code,p.name AS card_name
       FROM fatedrop_market_observations o
       JOIN fatedrop_card_identities c ON c.id=o.card_identity_id
       JOIN fatedrop_tcgs t ON t.id=c.tcg_id
       JOIN fatedrop_card_series cs ON cs.id=c.series_id
       JOIN fatedrop_card_sets s ON s.id=c.set_id
       JOIN fatedrop_card_printings p ON p.id=c.printing_id
      WHERE o.source_name=$1
        AND o.currency_code=$2
        AND o.market_segment_key=$3
        AND o.condition_code=$4
        AND o.market_day BETWEEN ($5::date - INTERVAL '30 days') AND $5::date
        AND ($6::text IS NULL OR t.code=$6)
        AND ($7::text IS NULL OR s.code=$7)
      ORDER BY o.market_day ASC,o.observed_at ASC,o.id ASC`,
    [basis.sourceName, basis.currencyCode, basis.marketSegmentKey, basis.conditionCode, anchorMarketDay, basis.tcgCode, basis.setCode],
  );

  const identities = new Map();
  const observations = [];
  for (const row of rows) {
    const observation = postgresObservation(row);
    if (!observation.marketDay) continue;
    observations.push(observation);
    const identity = postgresIdentity(row);
    if (identity) identities.set(identity.id, identity);
  }

  return Object.freeze({
    sourceType: 'postgres',
    anchorMarketDay,
    observations: Object.freeze(observations),
    cardIdentities: Object.freeze([...identities.values()]),
  });
}

export async function loadMarketPulseEvidence(store, input = {}) {
  const basis = normaliseInput(input);
  if (typeof store?.read === 'function') return fileEvidence(await store.read(), basis);
  if (typeof store?.pool === 'function') return postgresEvidence(store, basis);
  throw new Error('Market Pulse evidence store is unavailable');
}

export async function buildMarketPulseSnapshotFromStore(store, input = {}) {
  const basis = normaliseInput(input);
  const evidence = await loadMarketPulseEvidence(store, basis);
  const snapshot = buildMarketPulseSnapshot({
    observations: evidence.observations,
    cardIdentities: evidence.cardIdentities,
    sourceName: basis.sourceName,
    priceField: basis.priceField,
    currencyCode: basis.currencyCode,
    marketSegmentKey: basis.marketSegmentKey,
    conditionCode: basis.conditionCode,
    tcgCode: basis.tcgCode,
    setCode: basis.setCode,
    generatedAt: input.generatedAt ?? Date.now(),
  });
  return Object.freeze({ ...snapshot, evidenceSourceType: evidence.sourceType });
}
