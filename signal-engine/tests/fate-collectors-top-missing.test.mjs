import test from 'node:test';
import assert from 'node:assert/strict';

import { rankPricedMissingCards } from '../src/trader/collection/progress-service.mjs';

const missing = [
  { fateCardId: 'c1', printingId: 'p1', collectorNumber: '1', name: 'Alpha' },
  { fateCardId: 'c2', printingId: 'p2', collectorNumber: '2', name: 'Beta' },
  { fateCardId: 'c3', printingId: 'p3', collectorNumber: '3', name: 'Gamma' },
  { fateCardId: 'c4', printingId: 'p4', collectorNumber: '4', name: 'Delta' },
  { fateCardId: 'c5', printingId: 'p5', collectorNumber: '5', name: 'Unpriced' },
];

test('Binder top missing cards rank exact priced identities descending and cap at three', () => {
  const ranked = rankPricedMissingCards(missing, [
    { fateCardId: 'c1', amount: 12.5, currencyCode: 'GBP', observedAt: 10 },
    { fateCardId: 'c2', amount: 80, currencyCode: 'GBP', observedAt: 20 },
    { fateCardId: 'c3', amount: 35, currencyCode: 'GBP', observedAt: 30 },
    { fateCardId: 'c4', amount: 55, currencyCode: 'GBP', observedAt: 40 },
  ]);

  assert.deepEqual(ranked.map((card) => card.fateCardId), ['c2', 'c4', 'c3']);
  assert.deepEqual(ranked.map((card) => card.currentPrice), [80, 55, 35]);
  assert.equal(ranked[0].currencyCode, 'GBP');
  assert.equal(ranked[0].priceObservedAt, 20);
  assert.equal(Object.isFrozen(ranked), true);
});

test('Binder ranking never borrows a price from another exact card identity', () => {
  const ranked = rankPricedMissingCards(missing, [
    { fateCardId: 'different-finish', amount: 999, currencyCode: 'GBP', observedAt: 50 },
    { fateCardId: 'c1', amount: 12.5, currencyCode: 'GBP', observedAt: 10 },
  ]);

  assert.deepEqual(ranked.map((card) => card.fateCardId), ['c1']);
});

test('Binder ranking excludes unpriced missing cards instead of estimating them', () => {
  const ranked = rankPricedMissingCards(missing, []);
  assert.deepEqual(ranked, []);
});
