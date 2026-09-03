const DAY_MS = 86_400_000;
const PERIODS = Object.freeze({ d1: 1, d7: 7, d30: 30 });

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(6));
}

function dayText(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function shiftDay(day, amount) {
  const millis = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(millis + (amount * DAY_MS)).toISOString().slice(0, 10);
}

function laneKey(row) {
  return [
    row.cardIdentityId,
    row.sourceVariantKey ?? '',
    row.marketSegmentKey ?? '',
    row.conditionCode ?? '',
    row.currencyCode ?? '',
  ].join('|');
}

function groupCoverage(cards, mappedCardIds, keyFn) {
  const grouped = new Map();
  for (const card of cards) {
    const key = keyFn(card);
    const current = grouped.get(key) || { key, verifiedCards: 0, mappedCards: 0 };
    current.verifiedCards += 1;
    if (mappedCardIds.has(card.id)) current.mappedCards += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((item) => ({
      ...item,
      mappingCoveragePct: pct(item.mappedCards, item.verifiedCards),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function buildReport({ sourceName, canonicalSchemaAvailable, marketHistorySchemaAvailable, cards, mappings, observations, historyStats }) {
  const verifiedCards = cards.filter((card) => card.verificationStatus === 'verified');
  const mappedCardIds = new Set(mappings.map((mapping) => mapping.cardIdentityId));
  const verifiedCardIds = new Set(verifiedCards.map((card) => card.id));
  const validObservations = observations.filter((observation) => verifiedCardIds.has(observation.cardIdentityId));
  const observationCardIds = new Set(validObservations.map((observation) => observation.cardIdentityId));
  const verifiedSets = new Set(verifiedCards.map((card) => card.setCode).filter(Boolean));
  const verifiedTcgs = new Set(verifiedCards.map((card) => card.tcgCode).filter(Boolean));

  const marketDays = [...new Set(validObservations.map((item) => dayText(item.marketDay)).filter(Boolean))].sort();
  const latestMarketDay = dayText(historyStats.latestMarketDay) ?? marketDays.at(-1) ?? null;
  const earliestMarketDay = dayText(historyStats.earliestMarketDay) ?? marketDays[0] ?? null;
  const currentRows = latestMarketDay
    ? validObservations.filter((item) => dayText(item.marketDay) === latestMarketDay)
    : [];
  const currentLanes = new Map(currentRows.map((item) => [laneKey(item), item]));
  const observationsByDayLane = new Set(validObservations.map((item) => `${dayText(item.marketDay)}|${laneKey(item)}`));

  const exactBaselineCoverage = Object.fromEntries(Object.entries(PERIODS).map(([period, days]) => {
    if (!latestMarketDay) {
      return [period, { baselineMarketDay: null, eligibleLanes: 0, coveredLanes: 0, coveragePct: null }];
    }
    const baselineMarketDay = shiftDay(latestMarketDay, -days);
    let coveredLanes = 0;
    for (const key of currentLanes.keys()) {
      if (observationsByDayLane.has(`${baselineMarketDay}|${key}`)) coveredLanes += 1;
    }
    return [period, {
      baselineMarketDay,
      eligibleLanes: currentLanes.size,
      coveredLanes,
      coveragePct: pct(coveredLanes, currentLanes.size),
    }];
  }));

  const issues = [];
  if (!canonicalSchemaAvailable) issues.push('canonical_card_schema_missing');
  if (canonicalSchemaAvailable && verifiedCards.length === 0) issues.push('no_verified_cards');
  if (verifiedCards.length > 0 && mappedCardIds.size < verifiedCards.length) issues.push('source_mapping_coverage_incomplete');
  if (!marketHistorySchemaAvailable) issues.push('market_history_schema_missing');
  if (marketHistorySchemaAvailable && Number(historyStats.observationCount || 0) === 0) issues.push('no_market_history');
  if (latestMarketDay) {
    for (const period of Object.keys(PERIODS)) {
      const coverage = exactBaselineCoverage[period];
      if (coverage.coveredLanes < coverage.eligibleLanes) issues.push(`${period}_baseline_coverage_incomplete`);
    }
  }

  return Object.freeze({
    schemaVersion: 'market-data-readiness:1a2',
    sourceName,
    canonicalSchemaAvailable,
    marketHistorySchemaAvailable,
    canonical: Object.freeze({
      verifiedTcgs: verifiedTcgs.size,
      verifiedSets: verifiedSets.size,
      verifiedCards: verifiedCards.length,
      mappedCards: [...mappedCardIds].filter((id) => verifiedCardIds.has(id)).length,
      unmappedVerifiedCards: verifiedCards.filter((card) => !mappedCardIds.has(card.id)).length,
      mappingCoveragePct: pct([...mappedCardIds].filter((id) => verifiedCardIds.has(id)).length, verifiedCards.length),
      sourceMappings: mappings.length,
    }),
    history: Object.freeze({
      observations: Number(historyStats.observationCount || 0),
      observedCards: observationCardIds.size,
      distinctMarketDays: Number(historyStats.distinctMarketDays ?? marketDays.length),
      earliestMarketDay,
      latestMarketDay,
      currentLaneCount: currentLanes.size,
      exactBaselineCoverage: Object.freeze(exactBaselineCoverage),
    }),
    byTcg: Object.freeze(groupCoverage(verifiedCards, mappedCardIds, (card) => card.tcgCode || 'unknown')),
    bySet: Object.freeze(groupCoverage(verifiedCards, mappedCardIds, (card) => `${card.tcgCode || 'unknown'}|${card.setCode || card.setId || 'unknown'}`)),
    issues: Object.freeze(issues),
  });
}

function fileData(state, sourceName) {
  const catalogue = state?.traderCatalogue || {};
  const tcgs = catalogue.tcgs || {};
  const series = catalogue.series || {};
  const sets = catalogue.sets || {};
  const cards = Object.values(catalogue.cards || {}).map((card) => {
    const tcg = tcgs[card.tcgId] || Object.values(tcgs).find((item) => item?.id === card.tcgId) || null;
    const cardSeries = series[card.seriesId] || Object.values(series).find((item) => item?.id === card.seriesId) || null;
    const set = sets[card.setId] || Object.values(sets).find((item) => item?.id === card.setId) || null;
    return {
      id: card.id,
      verificationStatus: card.verificationStatus,
      tcgCode: tcg?.code ?? null,
      seriesCode: cardSeries?.code ?? null,
      setId: card.setId ?? null,
      setCode: set?.code ?? null,
    };
  });
  const mappings = Object.values(catalogue.cardSourceMappings || {})
    .filter((mapping) => mapping?.sourceName === sourceName)
    .map((mapping) => ({ cardIdentityId: mapping.cardIdentityId, sourceVariantKey: mapping.sourceVariantKey }));
  const allObservations = Object.values(state?.fateValueLab?.observations || {})
    .filter((observation) => observation?.sourceName === sourceName);
  const observations = allObservations.map((observation) => ({
    cardIdentityId: observation.cardIdentityId,
    sourceVariantKey: observation.sourceVariantKey,
    marketSegmentKey: observation.marketSegmentKey,
    conditionCode: observation.conditionCode,
    currencyCode: observation.currencyCode,
    marketDay: observation.marketDay,
  }));
  const days = allObservations.map((item) => dayText(item.marketDay)).filter(Boolean).sort();
  return {
    canonicalSchemaAvailable: Boolean(state?.traderCatalogue),
    marketHistorySchemaAvailable: Boolean(state?.fateValueLab),
    cards,
    mappings,
    observations,
    historyStats: {
      observationCount: allObservations.length,
      distinctMarketDays: new Set(days).size,
      earliestMarketDay: days[0] ?? null,
      latestMarketDay: days.at(-1) ?? null,
    },
  };
}

async function postgresData(store, sourceName) {
  const pool = await store.pool();
  const schema = await pool.query(`SELECT
      to_regclass('public.fatedrop_card_identities') IS NOT NULL AS card_identities,
      to_regclass('public.fatedrop_card_source_mappings') IS NOT NULL AS card_mappings,
      to_regclass('public.fatedrop_card_sets') IS NOT NULL AS card_sets,
      to_regclass('public.fatedrop_tcgs') IS NOT NULL AS tcgs,
      to_regclass('public.fatedrop_market_observations') IS NOT NULL AS market_observations`);
  const flags = schema.rows[0] || {};
  const canonicalSchemaAvailable = Boolean(flags.card_identities && flags.card_mappings && flags.card_sets && flags.tcgs);
  const marketHistorySchemaAvailable = Boolean(flags.market_observations);

  if (!canonicalSchemaAvailable) {
    return {
      canonicalSchemaAvailable,
      marketHistorySchemaAvailable,
      cards: [], mappings: [], observations: [],
      historyStats: { observationCount: 0, distinctMarketDays: 0, earliestMarketDay: null, latestMarketDay: null },
    };
  }

  const [cardResult, mappingResult] = await Promise.all([
    pool.query(`SELECT c.id,c.verification_status,t.code AS tcg_code,
                       s.code AS series_code,cs.id AS set_id,cs.code AS set_code
                  FROM fatedrop_card_identities c
                  LEFT JOIN fatedrop_tcgs t ON t.id=c.tcg_id
                  LEFT JOIN fatedrop_card_series s ON s.id=c.series_id
                  LEFT JOIN fatedrop_card_sets cs ON cs.id=c.set_id
                 WHERE c.verification_status='verified'`),
    pool.query(`SELECT m.card_identity_id,m.source_variant_key
                  FROM fatedrop_card_source_mappings m
                  JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
                 WHERE m.source_name=$1 AND c.verification_status='verified'`, [sourceName]),
  ]);

  const cards = cardResult.rows.map((row) => ({
    id: row.id,
    verificationStatus: row.verification_status,
    tcgCode: row.tcg_code,
    seriesCode: row.series_code,
    setId: row.set_id,
    setCode: row.set_code,
  }));
  const mappings = mappingResult.rows.map((row) => ({
    cardIdentityId: row.card_identity_id,
    sourceVariantKey: row.source_variant_key,
  }));

  if (!marketHistorySchemaAvailable) {
    return {
      canonicalSchemaAvailable,
      marketHistorySchemaAvailable,
      cards, mappings, observations: [],
      historyStats: { observationCount: 0, distinctMarketDays: 0, earliestMarketDay: null, latestMarketDay: null },
    };
  }

  const statsResult = await pool.query(`SELECT COUNT(*)::bigint AS observation_count,
      COUNT(DISTINCT market_day)::bigint AS distinct_market_days,
      MIN(market_day)::text AS earliest_market_day,
      MAX(market_day)::text AS latest_market_day
    FROM fatedrop_market_observations WHERE source_name=$1`, [sourceName]);
  const stats = statsResult.rows[0] || {};
  const latestMarketDay = dayText(stats.latest_market_day);
  let observations = [];
  if (latestMarketDay) {
    const historyResult = await pool.query(`SELECT DISTINCT
        o.card_identity_id,o.source_variant_key,o.market_segment_key,
        o.condition_code,o.currency_code,o.market_day::text AS market_day
      FROM fatedrop_market_observations o
      JOIN fatedrop_card_identities c ON c.id=o.card_identity_id
      WHERE o.source_name=$1
        AND c.verification_status='verified'
        AND o.market_day >= ($2::date - INTERVAL '30 days')
        AND o.market_day <= $2::date`, [sourceName, latestMarketDay]);
    observations = historyResult.rows.map((row) => ({
      cardIdentityId: row.card_identity_id,
      sourceVariantKey: row.source_variant_key,
      marketSegmentKey: row.market_segment_key,
      conditionCode: row.condition_code,
      currencyCode: row.currency_code,
      marketDay: row.market_day,
    }));
  }

  return {
    canonicalSchemaAvailable,
    marketHistorySchemaAvailable,
    cards,
    mappings,
    observations,
    historyStats: {
      observationCount: Number(stats.observation_count || 0),
      distinctMarketDays: Number(stats.distinct_market_days || 0),
      earliestMarketDay: stats.earliest_market_day,
      latestMarketDay: stats.latest_market_day,
    },
  };
}

export async function buildMarketDataReadinessReport(store, { sourceName = 'cardmarket' } = {}) {
  const normalizedSource = String(sourceName || '').trim().toLowerCase();
  if (!normalizedSource) throw new TypeError('sourceName is required');

  let data;
  if (typeof store?.read === 'function') data = fileData(await store.read(), normalizedSource);
  else if (typeof store?.pool === 'function') data = await postgresData(store, normalizedSource);
  else throw new Error('Market data readiness store is unavailable');

  return buildReport({ sourceName: normalizedSource, ...data });
}
