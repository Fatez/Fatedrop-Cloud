const DEFAULT_OBSERVATIONS_PER_CARD = 240;

export class FatePriceStoreUnavailableError extends Error {
  constructor(message = 'Fate Price market history is unavailable') {
    super(message);
    this.name = 'FatePriceStoreUnavailableError';
  }
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapRow(row) {
  return Object.freeze({
    id: String(row.id),
    cardIdentityId: String(row.card_identity_id),
    cardSourceMappingId: String(row.card_source_mapping_id),
    sourceName: String(row.source_name),
    sourceSnapshotId: String(row.source_snapshot_id),
    sourceRecordId: String(row.source_record_id),
    sourceVariantKey: String(row.source_variant_key),
    marketSegmentKey: String(row.market_segment_key),
    conditionCode: String(row.condition_code),
    currencyCode: String(row.currency_code),
    observedAt: Number(row.observed_at),
    sourceEffectiveAt: row.source_effective_at == null ? null : Number(row.source_effective_at),
    marketDay: row.market_day instanceof Date ? row.market_day.toISOString().slice(0, 10) : String(row.market_day),
    marketPrice: numberOrNull(row.market_price),
    lowPrice: numberOrNull(row.low_price),
    trendPrice: numberOrNull(row.trend_price),
    avg1d: numberOrNull(row.avg_1d),
    avg7d: numberOrNull(row.avg_7d),
    avg30d: numberOrNull(row.avg_30d),
    avgLifetime: numberOrNull(row.avg_lifetime),
    excellentPlusLow: numberOrNull(row.excellent_plus_low),
    metricsJson: row.metrics_json ?? {},
  });
}

function fileObservations(state, ids, safeLimit) {
  const verifiedCards = state?.traderCatalogue?.cards ?? {};
  const wanted = new Set(ids);
  const rows = Object.values(state?.fateValueLab?.observations ?? {})
    .filter((observation) => wanted.has(observation?.cardIdentityId))
    .filter((observation) => verifiedCards[observation.cardIdentityId]?.verificationStatus === 'verified')
    .sort((left, right) => {
      if (left.cardIdentityId !== right.cardIdentityId) return left.cardIdentityId.localeCompare(right.cardIdentityId);
      const leftAt = Number(left.sourceEffectiveAt ?? left.observedAt ?? 0);
      const rightAt = Number(right.sourceEffectiveAt ?? right.observedAt ?? 0);
      return rightAt - leftAt;
    });

  const perCard = new Map();
  return rows.filter((row) => {
    const count = perCard.get(row.cardIdentityId) ?? 0;
    if (count >= safeLimit) return false;
    perCard.set(row.cardIdentityId, count + 1);
    return true;
  });
}

export async function listFatePriceObservationsFromStore(store, {
  cardIdentityIds,
  observationsPerCard = DEFAULT_OBSERVATIONS_PER_CARD,
} = {}) {
  if (!Array.isArray(cardIdentityIds) || !cardIdentityIds.length) return [];
  const ids = [...new Set(cardIdentityIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return [];
  if (ids.length > 100) throw new TypeError('Fate Price supports at most 100 card identities per request');
  const safeLimit = Math.min(500, Math.max(60, Number(observationsPerCard) || DEFAULT_OBSERVATIONS_PER_CARD));

  if (typeof store?.read === 'function') {
    return fileObservations(await store.read(), ids, safeLimit);
  }
  if (typeof store?.pool !== 'function') throw new FatePriceStoreUnavailableError();

  try {
    const pool = await store.pool();
    const { rows } = await pool.query(`
      WITH ranked AS (
        SELECT
          o.*,
          ROW_NUMBER() OVER (
            PARTITION BY o.card_identity_id
            ORDER BY COALESCE(o.source_effective_at,o.observed_at) DESC,o.observed_at DESC,o.id DESC
          ) AS fate_price_rank
        FROM fatedrop_market_observations o
        JOIN fatedrop_card_identities c ON c.id=o.card_identity_id
        WHERE o.card_identity_id = ANY($1::text[])
          AND c.verification_status='verified'
      )
      SELECT * FROM ranked
      WHERE fate_price_rank <= $2
      ORDER BY card_identity_id,COALESCE(source_effective_at,observed_at) DESC,observed_at DESC,id DESC`,
    [ids, safeLimit]);
    return rows.map(mapRow);
  } catch (error) {
    if (error?.code === '42P01') {
      throw new FatePriceStoreUnavailableError('Fate Price market-history schema is not installed');
    }
    throw error;
  }
}
