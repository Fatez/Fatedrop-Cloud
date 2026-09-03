const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_MAX_AGE_MS = 7 * DAY_MS;
const MOVEMENT_SAMPLE_MAX_AGE_MS = 3 * DAY_MS;
const CENTRAL_SIGNAL_FIELDS = Object.freeze(['marketPrice', 'trendPrice', 'avg7d', 'avg30d']);

export const FATE_PRICE_POLICY_VERSION = 'fate-price-v1';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positivePrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestamp(observation) {
  const effective = Number(observation?.sourceEffectiveAt);
  if (Number.isFinite(effective) && effective > 0) return effective;
  const observed = Number(observation?.observedAt);
  return Number.isFinite(observed) && observed > 0 ? observed : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMoney(value) {
  return value == null ? null : Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPercent(value) {
  return value == null ? null : Math.round((value + Number.EPSILON) * 100) / 100;
}

function scopeOf(observation) {
  return Object.freeze({
    currencyCode: text(observation?.currencyCode)?.toUpperCase() ?? null,
    marketSegmentKey: text(observation?.marketSegmentKey) ?? 'default',
    conditionCode: text(observation?.conditionCode) ?? 'unspecified',
  });
}

function scopeKey(scope) {
  return `${scope.currencyCode ?? ''}|${scope.marketSegmentKey}|${scope.conditionCode}`;
}

function matchesScope(scope, filter) {
  if (filter.currencyCode && scope.currencyCode !== filter.currencyCode) return false;
  if (filter.marketSegmentKey && scope.marketSegmentKey !== filter.marketSegmentKey) return false;
  if (filter.conditionCode && scope.conditionCode !== filter.conditionCode) return false;
  return true;
}

function normalizeFilter({ currencyCode = null, marketSegmentKey = null, conditionCode = null } = {}) {
  return Object.freeze({
    currencyCode: text(currencyCode)?.toUpperCase() ?? null,
    marketSegmentKey: text(marketSegmentKey),
    conditionCode: text(conditionCode),
  });
}

function sourceEstimate(observation) {
  const signals = CENTRAL_SIGNAL_FIELDS
    .map((field) => ({ field, value: positivePrice(observation?.[field]) }))
    .filter((entry) => entry.value != null);
  if (signals.length < 2) return null;
  const values = signals.map((entry) => entry.value);
  return Object.freeze({
    sourceName: text(observation?.sourceName) ?? 'unknown',
    observationId: text(observation?.id),
    sourceSnapshotId: text(observation?.sourceSnapshotId),
    asOf: timestamp(observation),
    estimate: median(values),
    low: Math.min(...values),
    high: Math.max(...values),
    guideLow: positivePrice(observation?.lowPrice),
    signals: Object.freeze(signals),
  });
}

function latestBySource(observations, asOf, maxAgeMs) {
  const latest = new Map();
  for (const observation of observations) {
    const at = timestamp(observation);
    if (at == null || at > asOf) continue;
    const sourceName = text(observation?.sourceName) ?? 'unknown';
    const current = latest.get(sourceName);
    if (!current || at > current.at) latest.set(sourceName, { observation, at });
  }
  const availableBeforeAgeGate = [...latest.values()];
  const fresh = availableBeforeAgeGate.filter(({ at }) => asOf - at <= maxAgeMs);
  return { availableBeforeAgeGate, fresh };
}

function confidenceFor({ sourceEstimates, valuationAsOf, anchorAsOf, fairLow, fairHigh, amount }) {
  const sourceCount = sourceEstimates.length;
  const ageMs = Math.max(0, anchorAsOf - valuationAsOf);
  const spreadPercent = amount > 0 ? ((fairHigh - fairLow) / amount) * 100 : null;
  const reasons = [];

  if (sourceCount === 1) reasons.push('single_independent_market_source');
  else reasons.push('multiple_market_sources');

  if (ageMs <= 48 * 60 * 60 * 1000) reasons.push('fresh_within_48h');
  else if (ageMs <= 72 * 60 * 60 * 1000) reasons.push('fresh_within_72h');
  else reasons.push('aging_market_evidence');

  if (spreadPercent != null && spreadPercent <= 15) reasons.push('stable_guide_signals');
  else if (spreadPercent != null && spreadPercent <= 30) reasons.push('moderate_guide_spread');
  else reasons.push('wide_guide_spread');

  let level = 'low';
  if (sourceCount >= 2 && ageMs <= 48 * 60 * 60 * 1000 && spreadPercent != null && spreadPercent <= 20) {
    level = 'high';
  } else if (ageMs <= 72 * 60 * 60 * 1000 && spreadPercent != null && spreadPercent <= 30) {
    level = 'medium';
  }

  return Object.freeze({
    level,
    reasons: Object.freeze(reasons),
    sourceCount,
    spreadPercent: roundPercent(spreadPercent),
    ageHours: Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10,
  });
}

function snapshotPrice(observations, asOf, { maxAgeMs = CURRENT_MAX_AGE_MS } = {}) {
  const { availableBeforeAgeGate, fresh } = latestBySource(observations, asOf, maxAgeMs);
  if (!availableBeforeAgeGate.length) {
    return Object.freeze({ available: false, reason: 'NO_MARKET_EVIDENCE_AS_OF', asOf });
  }
  if (!fresh.length) {
    return Object.freeze({ available: false, reason: 'STALE_MARKET_EVIDENCE', asOf });
  }

  const sourceEstimates = fresh
    .map(({ observation }) => sourceEstimate(observation))
    .filter(Boolean);
  if (!sourceEstimates.length) {
    return Object.freeze({ available: false, reason: 'INSUFFICIENT_MARKET_SIGNALS', asOf });
  }

  const amount = median(sourceEstimates.map((source) => source.estimate));
  const fairLow = median(sourceEstimates.map((source) => source.low));
  const fairHigh = median(sourceEstimates.map((source) => source.high));
  const guideLows = sourceEstimates.map((source) => source.guideLow).filter((value) => value != null);
  const valuationAsOf = Math.max(...sourceEstimates.map((source) => source.asOf));

  return Object.freeze({
    available: true,
    asOf: valuationAsOf,
    amount,
    fairLow,
    fairHigh,
    guideLow: guideLows.length ? median(guideLows) : null,
    sourceEstimates: Object.freeze(sourceEstimates),
  });
}

function movement(current, observations, days) {
  if (!current?.available) return Object.freeze({ available: false, reason: 'CURRENT_PRICE_UNAVAILABLE' });
  const targetAsOf = current.asOf - (days * DAY_MS);
  const previous = snapshotPrice(observations, targetAsOf, { maxAgeMs: MOVEMENT_SAMPLE_MAX_AGE_MS });
  if (!previous.available || previous.amount <= 0) {
    return Object.freeze({
      available: false,
      reason: previous.reason,
      targetAsOf,
    });
  }
  const delta = current.amount - previous.amount;
  return Object.freeze({
    available: true,
    days,
    fromAmount: roundMoney(previous.amount),
    toAmount: roundMoney(current.amount),
    absolute: roundMoney(delta),
    percent: roundPercent((delta / previous.amount) * 100),
    fromAsOf: previous.asOf,
    toAsOf: current.asOf,
  });
}

function unavailable(cardIdentityId, reason, { scopes = [], filter = null } = {}) {
  return Object.freeze({
    contractVersion: 1,
    policyVersion: FATE_PRICE_POLICY_VERSION,
    cardIdentityId,
    available: false,
    reason,
    marketScope: null,
    price: null,
    movement: Object.freeze({ d7: Object.freeze({ available: false, reason }), d30: Object.freeze({ available: false, reason }) }),
    confidence: null,
    evidence: Object.freeze({
      availableScopes: Object.freeze(scopes),
      requestedScope: filter,
      sourceCount: 0,
      sources: Object.freeze([]),
    }),
  });
}

export function calculateFatePrice(observations, {
  cardIdentityId,
  currencyCode = null,
  marketSegmentKey = null,
  conditionCode = null,
  now = Date.now(),
} = {}) {
  if (typeof cardIdentityId !== 'string' || !cardIdentityId.trim()) {
    throw new TypeError('cardIdentityId is required');
  }
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  if (!Number.isFinite(now) || now <= 0) throw new TypeError('now must be a positive timestamp');

  const id = cardIdentityId.trim();
  const filter = normalizeFilter({ currencyCode, marketSegmentKey, conditionCode });
  const exact = observations.filter((observation) => observation?.cardIdentityId === id);
  if (!exact.length) return unavailable(id, 'NO_VERIFIED_MARKET_EVIDENCE', { filter });

  const groups = new Map();
  for (const observation of exact) {
    const scope = scopeOf(observation);
    if (!scope.currencyCode || !matchesScope(scope, filter)) continue;
    const key = scopeKey(scope);
    const entry = groups.get(key) ?? { scope, observations: [] };
    entry.observations.push(observation);
    groups.set(key, entry);
  }

  const availableScopes = [...groups.values()]
    .map((entry) => entry.scope)
    .sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)));
  if (!groups.size) return unavailable(id, 'NO_MARKET_EVIDENCE_FOR_SCOPE', { scopes: availableScopes, filter });
  if (groups.size > 1) return unavailable(id, 'AMBIGUOUS_MARKET_SCOPE', { scopes: availableScopes, filter });

  const [{ scope, observations: scoped }] = groups.values();
  const current = snapshotPrice(scoped, now);
  if (!current.available) return unavailable(id, current.reason, { scopes: availableScopes, filter });

  const roundedAmount = roundMoney(current.amount);
  const roundedLow = roundMoney(current.fairLow);
  const roundedHigh = roundMoney(current.fairHigh);
  const sources = current.sourceEstimates.map((source) => source.sourceName).sort();
  const confidence = confidenceFor({
    sourceEstimates: current.sourceEstimates,
    valuationAsOf: current.asOf,
    anchorAsOf: now,
    fairLow: current.fairLow,
    fairHigh: current.fairHigh,
    amount: current.amount,
  });

  return Object.freeze({
    contractVersion: 1,
    policyVersion: FATE_PRICE_POLICY_VERSION,
    cardIdentityId: id,
    available: true,
    reason: null,
    marketScope: scope,
    price: Object.freeze({
      amount: roundedAmount,
      currencyCode: scope.currencyCode,
      fairLow: roundedLow,
      fairHigh: roundedHigh,
      guideLow: roundMoney(current.guideLow),
      asOf: current.asOf,
    }),
    movement: Object.freeze({
      d7: movement(current, scoped, 7),
      d30: movement(current, scoped, 30),
    }),
    confidence,
    evidence: Object.freeze({
      availableScopes: Object.freeze(availableScopes),
      requestedScope: filter,
      sourceCount: current.sourceEstimates.length,
      sources: Object.freeze(sources),
      centralSignals: Object.freeze([...CENTRAL_SIGNAL_FIELDS]),
      centralPolicy: 'median_of_each_source_market_trend_7d_30d_then_median_across_sources',
      lowestListingUsedInCentralPrice: false,
      sourceEstimates: Object.freeze(current.sourceEstimates.map((source) => Object.freeze({
        sourceName: source.sourceName,
        asOf: source.asOf,
        estimate: roundMoney(source.estimate),
        rangeLow: roundMoney(source.low),
        rangeHigh: roundMoney(source.high),
        guideLow: roundMoney(source.guideLow),
        signals: Object.freeze(source.signals.map((signal) => Object.freeze({ field: signal.field, value: roundMoney(signal.value) }))),
      }))),
    }),
  });
}
