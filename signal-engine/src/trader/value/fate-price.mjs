import { assertFatePriceProviderApproved } from './provider-policy.mjs';

const METRIC_PRIORITY = Object.freeze([
  'marketPrice',
  'trendPrice',
  'avg7d',
  'avg30d',
]);

const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const HIGH_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function currency(value) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currencyCode must be a 3-letter currency code');
  return code;
}

function timestamp(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${field} must be a positive timestamp`);
  return number;
}

function positiveDuration(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${field} must be positive`);
  return number;
}

function nonNegativePrice(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

function bestMetric(observation) {
  for (const metric of METRIC_PRIORITY) {
    const value = nonNegativePrice(observation?.[metric]);
    if (value != null && value > 0) return Object.freeze({ metric, amount: value });
  }
  return null;
}

function effectiveAt(observation) {
  return timestamp(observation?.sourceEffectiveAt, 'sourceEffectiveAt')
    ?? timestamp(observation?.observedAt, 'observedAt');
}

function confidence(metric, ageMs) {
  if (ageMs <= HIGH_FRESHNESS_MS && (metric === 'marketPrice' || metric === 'trendPrice')) return 'high';
  if (metric === 'marketPrice' || metric === 'trendPrice' || metric === 'avg7d') return 'medium';
  return 'low';
}

function freshness(ageMs) {
  return ageMs <= HIGH_FRESHNESS_MS ? 'fresh' : 'recent';
}

function unavailable({ cardIdentityId, currencyCode, reason, rejectedEvidence = [] }) {
  return Object.freeze({
    status: 'unavailable',
    reason,
    valuationKind: 'raw-market',
    cardIdentityId,
    amount: null,
    currencyCode,
    metricUsed: null,
    sourceName: null,
    providerPolicyKey: null,
    sourceSnapshotId: null,
    sourceEffectiveAt: null,
    observedAt: null,
    ageMs: null,
    freshness: null,
    confidence: null,
    rejectedEvidence: Object.freeze(rejectedEvidence),
  });
}

/**
 * Resolve one exact canonical card identity to one conservative current Fate Price.
 *
 * Acquisition provenance is mandatory. A source name such as "cardmarket" is not
 * sufficient because the same provider can expose both approved and restricted
 * acquisition routes. Callers should enrich persisted market observations with
 * providerPolicyKey from the corresponding ingest run before invoking this function.
 */
export function resolveFatePrice({
  cardIdentityId,
  observations,
  currencyCode,
  asOf = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const cardId = text(cardIdentityId);
  if (!cardId) throw new TypeError('cardIdentityId is required');
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  const code = currency(currencyCode);
  const now = timestamp(asOf, 'asOf');
  const maxAge = positiveDuration(maxAgeMs, 'maxAgeMs');

  const eligible = [];
  const rejectedEvidence = [];

  for (const observation of observations) {
    if (!observation || text(observation.cardIdentityId) !== cardId) continue;
    if (currency(observation.currencyCode) !== code) continue;

    const providerPolicyKey = text(observation.providerPolicyKey);
    if (!providerPolicyKey) {
      rejectedEvidence.push(Object.freeze({
        sourceName: text(observation.sourceName) || null,
        reason: 'provider_policy_missing',
      }));
      continue;
    }

    let policy;
    try {
      policy = assertFatePriceProviderApproved(providerPolicyKey);
    } catch (error) {
      rejectedEvidence.push(Object.freeze({
        sourceName: text(observation.sourceName) || null,
        providerPolicyKey,
        reason: error?.code || 'provider_policy_not_approved',
      }));
      continue;
    }

    if (policy.sourceName !== text(observation.sourceName)) {
      rejectedEvidence.push(Object.freeze({
        sourceName: text(observation.sourceName) || null,
        providerPolicyKey,
        reason: 'provider_policy_source_mismatch',
      }));
      continue;
    }

    const metric = bestMetric(observation);
    if (!metric) {
      rejectedEvidence.push(Object.freeze({
        sourceName: policy.sourceName,
        providerPolicyKey,
        reason: 'supported_market_metric_unavailable',
      }));
      continue;
    }

    let priceEffectiveAt;
    try {
      priceEffectiveAt = effectiveAt(observation);
    } catch {
      rejectedEvidence.push(Object.freeze({
        sourceName: policy.sourceName,
        providerPolicyKey,
        reason: 'price_timestamp_invalid',
      }));
      continue;
    }
    if (priceEffectiveAt == null) {
      rejectedEvidence.push(Object.freeze({
        sourceName: policy.sourceName,
        providerPolicyKey,
        reason: 'price_timestamp_missing',
      }));
      continue;
    }

    const ageMs = now - priceEffectiveAt;
    if (ageMs < 0 || ageMs > maxAge) {
      rejectedEvidence.push(Object.freeze({
        sourceName: policy.sourceName,
        providerPolicyKey,
        reason: ageMs < 0 ? 'price_timestamp_in_future' : 'price_stale',
      }));
      continue;
    }

    eligible.push(Object.freeze({
      observation,
      policy,
      metric,
      priceEffectiveAt,
      ageMs,
    }));
  }

  if (!eligible.length) {
    return unavailable({
      cardIdentityId: cardId,
      currencyCode: code,
      reason: rejectedEvidence.length ? 'no_approved_current_price_evidence' : 'no_matching_price_evidence',
      rejectedEvidence,
    });
  }

  eligible.sort((left, right) => {
    if (left.priceEffectiveAt !== right.priceEffectiveAt) return right.priceEffectiveAt - left.priceEffectiveAt;
    const metricOrder = METRIC_PRIORITY.indexOf(left.metric.metric) - METRIC_PRIORITY.indexOf(right.metric.metric);
    if (metricOrder !== 0) return metricOrder;
    const leftObserved = Number(left.observation.observedAt || 0);
    const rightObserved = Number(right.observation.observedAt || 0);
    if (leftObserved !== rightObserved) return rightObserved - leftObserved;
    return String(left.policy.key).localeCompare(String(right.policy.key));
  });

  const chosen = eligible[0];
  return Object.freeze({
    status: 'available',
    reason: null,
    valuationKind: 'raw-market',
    cardIdentityId: cardId,
    fateCardId: cardId,
    amount: Number(chosen.metric.amount.toFixed(2)),
    currencyCode: code,
    metricUsed: chosen.metric.metric,
    sourceName: chosen.policy.sourceName,
    providerPolicyKey: chosen.policy.key,
    sourceSnapshotId: text(chosen.observation.sourceSnapshotId) || null,
    sourceEffectiveAt: chosen.observation.sourceEffectiveAt ?? null,
    observedAt: chosen.observation.observedAt ?? null,
    ageMs: chosen.ageMs,
    freshness: freshness(chosen.ageMs),
    confidence: confidence(chosen.metric.metric, chosen.ageMs),
    rejectedEvidence: Object.freeze(rejectedEvidence),
  });
}
