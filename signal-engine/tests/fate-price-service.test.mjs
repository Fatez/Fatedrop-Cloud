import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFatePricesFromStore } from '../src/trader/value/fate-price-service.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function run({
  id = 'run_1',
  sourceName = 'cardmarket',
  sourceSnapshotId = 'pokemon-price-guide-v1',
  providerPolicyKey = 'cardmarket-public-download',
} = {}) {
  return {
    id,
    sourceName,
    sourceSnapshotId,
    metadataJson: { providerPolicyKey },
  };
}

function observation({
  id = 'obs_1',
  ingestRunId = 'run_1',
  cardIdentityId = 'card_1',
  sourceName = 'cardmarket',
  sourceSnapshotId = 'pokemon-price-guide-v1',
  currencyCode = 'EUR',
  sourceEffectiveAt = NOW - 60 * 60 * 1000,
  trendPrice = 12.34,
} = {}) {
  return {
    id,
    ingestRunId,
    cardIdentityId,
    sourceName,
    sourceSnapshotId,
    currencyCode,
    sourceEffectiveAt,
    observedAt: sourceEffectiveAt + 1_000,
    trendPrice,
  };
}

function fileStore(state) {
  return { read: async () => state };
}

test('resolves approved current Cardmarket evidence from a file store', async () => {
  const store = fileStore({
    fateValueLab: {
      ingestRuns: { run_1: run() },
      observations: { obs_1: observation() },
    },
  });

  const result = await loadFatePricesFromStore(store, {
    cardIdentityIds: ['card_1'],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.status, 'available');
  assert.equal(result.availablePriceCount, 1);
  assert.equal(result.evidenceSourceType, 'file');
  assert.equal(result.prices[0].amount, 12.34);
  assert.equal(result.prices[0].metricUsed, 'trendPrice');
  assert.equal(result.prices[0].providerPolicyKey, 'cardmarket-public-download');
});

test('historical as-of reads ignore newer evidence and resolve the price available then', async () => {
  const sevenDaysAgo = NOW - 7 * DAY;
  const store = fileStore({
    fateValueLab: {
      ingestRuns: {
        current: run({ id: 'current', sourceSnapshotId: 'current-snapshot' }),
        baseline: run({ id: 'baseline', sourceSnapshotId: 'baseline-snapshot' }),
      },
      observations: {
        current: observation({ id: 'current', ingestRunId: 'current', sourceSnapshotId: 'current-snapshot', sourceEffectiveAt: NOW - 60 * 60 * 1000, trendPrice: 20 }),
        baseline: observation({ id: 'baseline', ingestRunId: 'baseline', sourceSnapshotId: 'baseline-snapshot', sourceEffectiveAt: sevenDaysAgo - 60 * 60 * 1000, trendPrice: 10 }),
      },
    },
  });

  const current = await loadFatePricesFromStore(store, {
    cardIdentityIds: ['card_1'],
    currencyCode: 'EUR',
    asOf: NOW,
  });
  const baseline = await loadFatePricesFromStore(store, {
    cardIdentityIds: ['card_1'],
    currencyCode: 'EUR',
    asOf: sevenDaysAgo,
  });

  assert.equal(current.prices[0].amount, 20);
  assert.equal(baseline.prices[0].amount, 10);
  assert.equal(baseline.asOf, sevenDaysAgo);
});

test('does not allow blocked or unprovenanced evidence to become Fate Price', async () => {
  const store = fileStore({
    fateValueLab: {
      ingestRuns: {
        blocked: run({ id: 'blocked', sourceSnapshotId: 'wizard-snapshot', sourceName: 'pokemon-wizard', providerPolicyKey: 'pokemon-wizard' }),
        missing: { id: 'missing', sourceName: 'cardmarket', sourceSnapshotId: 'missing-policy', metadataJson: {} },
      },
      observations: {
        blocked: observation({ id: 'blocked', ingestRunId: 'blocked', sourceName: 'pokemon-wizard', sourceSnapshotId: 'wizard-snapshot', trendPrice: 999 }),
        missing: observation({ id: 'missing', ingestRunId: 'missing', sourceSnapshotId: 'missing-policy', trendPrice: 888 }),
      },
    },
  });

  const result = await loadFatePricesFromStore(store, {
    cardIdentityIds: ['card_1'],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.availablePriceCount, 0);
  assert.equal(result.rejectedProvenanceCount, 2);
  assert.equal(result.prices[0].status, 'unavailable');
});

test('does not silently cross currencies and reports mixed coverage', async () => {
  const store = fileStore({
    fateValueLab: {
      ingestRuns: { run_1: run() },
      observations: {
        eur: observation({ id: 'eur', cardIdentityId: 'card_1' }),
        gbp: observation({ id: 'gbp', cardIdentityId: 'card_2', currencyCode: 'GBP', trendPrice: 25 }),
      },
    },
  });

  const result = await loadFatePricesFromStore(store, {
    cardIdentityIds: ['card_1', 'card_2'],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.availablePriceCount, 1);
  assert.equal(result.unavailablePriceCount, 1);
  assert.equal(result.prices.find((price) => price.cardIdentityId === 'card_2').status, 'unavailable');
});

test('fails closed when Postgres market-history tables are not deployed', async () => {
  const store = {
    pool: async () => ({
      query: async () => {
        const error = new Error('relation does not exist');
        error.code = '42P01';
        throw error;
      },
    }),
  };

  const result = await loadFatePricesFromStore(store, {
    cardIdentityIds: ['card_1'],
    currencyCode: 'EUR',
    asOf: NOW,
  });

  assert.equal(result.status, 'building');
  assert.equal(result.reason, 'market_history_schema_missing');
  assert.equal(result.prices[0].status, 'unavailable');
});
