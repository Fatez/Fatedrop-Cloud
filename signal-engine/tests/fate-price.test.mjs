import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFatePrice, calculateFatePriceHistory } from '../src/trader/value/fate-price.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 3, 10, 0, 0);

function observation({
  id,
  at = NOW - (6 * 60 * 60 * 1000),
  source = 'cardmarket',
  segment = 'standard',
  currency = 'EUR',
  trend = 10,
  avg7 = 11,
  avg30 = 12,
  avg1 = 50,
  low = 5,
  market = null,
} = {}) {
  return {
    id: id || `${source}-${segment}-${at}`,
    cardIdentityId: 'fdcard_1',
    sourceName: source,
    sourceSnapshotId: `snapshot-${at}`,
    sourceEffectiveAt: at,
    observedAt: at,
    marketSegmentKey: segment,
    conditionCode: 'unspecified',
    currencyCode: currency,
    marketPrice: market,
    trendPrice: trend,
    avg7d: avg7,
    avg30d: avg30,
    avg1d: avg1,
    lowPrice: low,
  };
}

test('Fate Price central estimate ignores lowest listing and 1D noise', () => {
  const result = calculateFatePrice([observation()], { cardIdentityId: 'fdcard_1', now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.price.amount, 11);
  assert.equal(result.price.fairLow, 10);
  assert.equal(result.price.fairHigh, 12);
  assert.equal(result.price.guideLow, 5);
  assert.equal(result.evidence.lowestListingUsedInCentralPrice, false);
  assert.equal(result.evidence.centralSignals.includes('avg1d'), false);
  assert.equal(result.evidence.centralSignals.includes('lowPrice'), false);
});

test('7D and 30D movement use actual historical snapshots rather than provider rolling averages', () => {
  const rows = [
    observation({ at: NOW - (6 * 60 * 60 * 1000), trend: 20, avg7: 20, avg30: 20 }),
    observation({ at: NOW - (7 * DAY) - (6 * 60 * 60 * 1000), trend: 10, avg7: 10, avg30: 10 }),
    observation({ at: NOW - (30 * DAY) - (6 * 60 * 60 * 1000), trend: 5, avg7: 5, avg30: 5 }),
  ];
  const result = calculateFatePrice(rows, { cardIdentityId: 'fdcard_1', now: NOW });
  assert.equal(result.movement.d7.available, true);
  assert.equal(result.movement.d7.percent, 100);
  assert.equal(result.movement.d30.available, true);
  assert.equal(result.movement.d30.percent, 300);
});

test('market segment, condition and currency ambiguity fail closed', () => {
  const rows = [observation({ segment: 'standard' }), observation({ segment: 'holo' })];
  const ambiguous = calculateFatePrice(rows, { cardIdentityId: 'fdcard_1', now: NOW });
  assert.equal(ambiguous.available, false);
  assert.equal(ambiguous.reason, 'AMBIGUOUS_MARKET_SCOPE');

  const holo = calculateFatePrice(rows, { cardIdentityId: 'fdcard_1', marketSegmentKey: 'holo', now: NOW });
  assert.equal(holo.available, true);
  assert.equal(holo.marketScope.marketSegmentKey, 'holo');
});

test('insufficient or stale market evidence never invents a Fate Price', () => {
  const insufficient = calculateFatePrice([
    observation({ trend: 10, avg7: null, avg30: null }),
  ], { cardIdentityId: 'fdcard_1', now: NOW });
  assert.equal(insufficient.available, false);
  assert.equal(insufficient.reason, 'INSUFFICIENT_MARKET_SIGNALS');

  const stale = calculateFatePrice([
    observation({ at: NOW - (8 * DAY) }),
  ], { cardIdentityId: 'fdcard_1', now: NOW });
  assert.equal(stale.available, false);
  assert.equal(stale.reason, 'STALE_MARKET_EVIDENCE');
});

test('independent source estimates combine by median and can raise confidence', () => {
  const rows = [
    observation({ source: 'cardmarket', trend: 10, avg7: 11, avg30: 12 }),
    observation({ source: 'other-market', market: 14, trend: 15, avg7: 16, avg30: null }),
  ];
  const result = calculateFatePrice(rows, { cardIdentityId: 'fdcard_1', now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.price.amount, 13);
  assert.equal(result.evidence.sourceCount, 2);
  assert.equal(result.confidence.level, 'high');
});

test('history returns only Cloud-calculated points anchored to stored market days', () => {
  const rows = [
    observation({ at: NOW - (6 * 60 * 60 * 1000), trend: 20, avg7: 20, avg30: 20 }),
    observation({ at: NOW - (7 * DAY) - (6 * 60 * 60 * 1000), trend: 10, avg7: 10, avg30: 10 }),
    observation({ at: NOW - (30 * DAY) - (6 * 60 * 60 * 1000), trend: 5, avg7: 5, avg30: 5 }),
  ];
  const result = calculateFatePriceHistory(rows, {
    cardIdentityId: 'fdcard_1',
    days: 30,
    now: NOW,
  });

  assert.equal(result.available, true);
  assert.equal(result.days, 30);
  assert.deepEqual(result.points.map((point) => point.amount), [10, 20]);
  assert.equal(result.evidence.pointPolicy, 'stored_market_days_only_no_interpolation');
  assert.equal(result.points.length, 2);
});

test('history fails closed for scope ambiguity and unsupported windows', () => {
  const rows = [observation({ segment: 'standard' }), observation({ segment: 'holo' })];
  const ambiguous = calculateFatePriceHistory(rows, {
    cardIdentityId: 'fdcard_1',
    days: 7,
    now: NOW,
  });
  assert.equal(ambiguous.available, false);
  assert.equal(ambiguous.reason, 'AMBIGUOUS_MARKET_SCOPE');
  assert.deepEqual(ambiguous.points, []);
  assert.throws(
    () => calculateFatePriceHistory(rows, { cardIdentityId: 'fdcard_1', days: 14, now: NOW }),
    /must be 7, 30, or 90/,
  );
});
