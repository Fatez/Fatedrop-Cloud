import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCardmarketDailyExactMappingResolver,
  ingestCardmarketDailyPriceGuide,
  prepareCardmarketDailyPriceGuideBatch,
  sourceVariantKeyForCardmarketPriceLane,
} from '../src/trader/value/cardmarket-daily-ingest.mjs';

const DAY_1 = Date.parse('2026-08-28T08:00:00.000Z');
const DAY_2 = Date.parse('2026-08-29T08:00:00.000Z');

function makeStore({ includeHolo = false } = {}) {
  let state = {
    traderCatalogue: {
      cards: {
        card_normal: { id: 'card_normal', verificationStatus: 'verified' },
        card_holo: { id: 'card_holo', verificationStatus: 'verified' },
      },
      cardSourceMappings: {
        normal: {
          id: 'map_normal',
          cardIdentityId: 'card_normal',
          sourceName: 'cardmarket',
          sourceRecordId: '668227',
          sourceVariantKey: 'normal',
        },
        ...(includeHolo ? {
          holo: {
            id: 'map_holo',
            cardIdentityId: 'card_holo',
            sourceName: 'cardmarket',
            sourceRecordId: '668227',
            sourceVariantKey: 'holo',
          },
        } : {}),
      },
    },
  };

  return {
    read: async () => state,
    mutate: async (fn) => {
      const result = await fn(state);
      return result;
    },
    snapshot: () => structuredClone(state),
  };
}

function payload(createdAt, { trend = 10, holo = false } = {}) {
  return {
    version: 1,
    createdAt,
    priceGuides: [{
      idProduct: 668227,
      idCategory: 51,
      avg: trend,
      low: Math.max(0, trend - 2),
      trend,
      avg1: trend,
      avg7: trend,
      avg30: trend,
      'avg-holo': holo ? trend + 2 : null,
      'low-holo': holo ? trend : null,
      'trend-holo': holo ? trend + 2 : 0,
      'avg1-holo': holo ? trend + 2 : null,
      'avg7-holo': holo ? trend + 2 : null,
      'avg30-holo': holo ? trend + 2 : null,
    }],
  };
}

test('Cardmarket price lanes resolve only their explicit source mapping keys', async () => {
  assert.equal(sourceVariantKeyForCardmarketPriceLane('standard'), 'normal');
  assert.equal(sourceVariantKeyForCardmarketPriceLane('holo'), 'holo');
  assert.throws(() => sourceVariantKeyForCardmarketPriceLane('reverse'), /unsupported Cardmarket price lane/);

  const resolve = createCardmarketDailyExactMappingResolver(makeStore({ includeHolo: true }));
  const standard = await resolve({
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    priceGuideLane: 'standard',
  });
  const holo = await resolve({
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    priceGuideLane: 'holo',
  });

  assert.equal(standard.id, 'map_normal');
  assert.equal(standard.cardIdentityId, 'card_normal');
  assert.equal(holo.id, 'map_holo');
  assert.equal(holo.cardIdentityId, 'card_holo');
});

test('unmapped meaningful lanes are quarantined before persistence', async () => {
  const batch = await prepareCardmarketDailyPriceGuideBatch({
    store: makeStore(),
    priceGuidePayload: payload('2026-08-28T08:00:00+0000', { holo: true }),
    observedAt: DAY_1,
  });

  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].sourceVariantKey, 'normal');
  assert.equal(batch.rejections.length, 1);
  assert.equal(batch.rejections[0].sourceVariantKey, 'holo');
  assert.equal(batch.rejections[0].rejectionCode, 'identity_unresolved');
  assert.equal(batch.run.status, 'partial');
});

test('daily ingestion is idempotent for the same immutable provider snapshot', async () => {
  const store = makeStore();
  const input = {
    store,
    priceGuidePayload: payload('2026-08-28T08:00:00+0000'),
    observedAt: DAY_1,
  };

  const first = await ingestCardmarketDailyPriceGuide(input);
  const replay = await ingestCardmarketDailyPriceGuide({ ...input, observedAt: DAY_1 + 60_000 });

  assert.equal(first.insertedObservations, 1);
  assert.equal(first.duplicateObservations, 0);
  assert.equal(replay.insertedObservations, 0);
  assert.equal(replay.duplicateObservations, 1);
  assert.equal(Object.keys(store.snapshot().fateValueLab.observations).length, 1);
});

test('a later provider snapshot adds another historical market day', async () => {
  const store = makeStore();

  const first = await ingestCardmarketDailyPriceGuide({
    store,
    priceGuidePayload: payload('2026-08-28T08:00:00+0000', { trend: 10 }),
    observedAt: DAY_1,
  });
  const second = await ingestCardmarketDailyPriceGuide({
    store,
    priceGuidePayload: payload('2026-08-29T08:00:00+0000', { trend: 12 }),
    observedAt: DAY_2,
  });

  assert.equal(first.insertedObservations, 1);
  assert.equal(second.insertedObservations, 1);
  const observations = Object.values(store.snapshot().fateValueLab.observations);
  assert.deepEqual(observations.map((item) => item.marketDay).sort(), ['2026-08-28', '2026-08-29']);
  assert.deepEqual(observations.map((item) => item.trendPrice).sort((a, b) => a - b), [10, 12]);
});
