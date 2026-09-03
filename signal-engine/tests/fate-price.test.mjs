import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFatePrice } from '../src/trader/value/fate-price.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-03T12:00:00Z');

function observation(overrides = {}) {
  return {
    cardIdentityId: 'card-1',
    sourceName: 'cardmarket',
    providerPolicyKey: 'cardmarket-public-download',
    sourceSnapshotId: 'pokemon-price-guide-v1-test',
    currencyCode: 'EUR',
    sourceEffectiveAt: NOW - HOUR,
    observedAt: NOW - HOUR,
    marketPrice: null,
    lowPrice: 1,
    trendPrice: 10,
    avg7d: 9,
    avg30d: 8,
    ...overrides,
  };
}

test('Fate Price prefers provider market price over trend and averages, never low listing by default', () => {
  const result = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [observation({ marketPrice: 12, lowPrice: 2, trendPrice: 11, avg7d: 10 })],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.status, 'available');
  assert.equal(result.amount, 12);
  assert.equal(result.metricUsed, 'marketPrice');
  assert.equal(result.valuationKind, 'raw-market');
  assert.equal(result.providerPolicyKey, 'cardmarket-public-download');
});

test('Fate Price uses trend then 7d then 30d, but does not promote low price to market value', () => {
  const trend = resolveFatePrice({ cardIdentityId: 'card-1', observations: [observation()], currencyCode: 'EUR', asOf: NOW });
  assert.equal(trend.metricUsed, 'trendPrice');
  assert.equal(trend.amount, 10);

  const avg7 = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [observation({ trendPrice: null })],
    currencyCode: 'EUR',
    asOf: NOW,
  });
  assert.equal(avg7.metricUsed, 'avg7d');

  const avg30 = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [observation({ trendPrice: null, avg7d: null })],
    currencyCode: 'EUR',
    asOf: NOW,
  });
  assert.equal(avg30.metricUsed, 'avg30d');

  const lowOnly = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [observation({ trendPrice: null, avg7d: null, avg30d: null, lowPrice: 99 })],
    currencyCode: 'EUR',
    asOf: NOW,
  });
  assert.equal(lowOnly.status, 'unavailable');
});

test('freshest approved observation wins before metric hierarchy across snapshots', () => {
  const result = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [
      observation({ sourceEffectiveAt: NOW - 2 * HOUR, marketPrice: 50, trendPrice: null }),
      observation({ sourceEffectiveAt: NOW - HOUR, marketPrice: null, trendPrice: 40 }),
    ],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.amount, 40);
  assert.equal(result.metricUsed, 'trendPrice');
});

test('stale, wrong-card and wrong-currency evidence cannot become Fate Price', () => {
  const result = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [
      observation({ cardIdentityId: 'other-card', marketPrice: 100 }),
      observation({ currencyCode: 'GBP', marketPrice: 100 }),
      observation({ sourceEffectiveAt: NOW - 80 * HOUR, observedAt: NOW - 80 * HOUR, marketPrice: 100 }),
    ],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.amount, null);
});

test('blocked or unreviewed acquisition provenance is ignored while approved evidence remains usable', () => {
  const result = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [
      observation({ providerPolicyKey: 'pokemon-wizard', sourceName: 'pokemon-wizard', marketPrice: 999 }),
      observation({ providerPolicyKey: 'cardmarket-api', marketPrice: 888 }),
      observation({ marketPrice: 12 }),
    ],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.status, 'available');
  assert.equal(result.amount, 12);
  assert.ok(result.rejectedEvidence.length >= 2);
});

test('Fate Price preserves source currency and performs no silent FX conversion', () => {
  const result = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [observation({ marketPrice: 12 })],
    currencyCode: 'GBP',
    asOf: NOW,
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.currencyCode, 'GBP');
});

test('confidence is deterministic from metric quality and freshness', () => {
  const high = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [observation({ marketPrice: 12 })],
    currencyCode: 'EUR',
    asOf: NOW,
  });
  assert.equal(high.confidence, 'high');
  assert.equal(high.freshness, 'fresh');

  const medium = resolveFatePrice({
    cardIdentityId: 'card-1',
    observations: [observation({ sourceEffectiveAt: NOW - 48 * HOUR, observedAt: NOW - 48 * HOUR, marketPrice: null, trendPrice: null, avg7d: 9 })],
    currencyCode: 'EUR',
    asOf: NOW,
  });
  assert.equal(medium.confidence, 'medium');
  assert.equal(medium.freshness, 'recent');
});
