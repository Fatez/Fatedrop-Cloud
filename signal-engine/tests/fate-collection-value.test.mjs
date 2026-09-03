import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFateCollectionValue } from '../src/trader/value/collection-value.mjs';

function item(id, fateCardId, quantity = 1, extra = {}) {
  return {
    id,
    fateCardId,
    quantity,
    status: 'active',
    copyState: 'raw',
    ...extra,
  };
}

function value(fateCardId, amount, observedAt = 100) {
  return {
    fateCardId,
    amount,
    currencyCode: 'GBP',
    observedAt,
    valuationKind: 'raw-market',
    sourceName: 'test-market',
  };
}

test('collection value counts exact identities and quantities', () => {
  const result = computeFateCollectionValue({
    collectionItems: [
      item('i1', 'normal-charizard', 2),
      item('i2', 'reverse-charizard', 1),
    ],
    cardValues: [
      value('normal-charizard', 10),
      value('reverse-charizard', 15),
    ],
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'available');
  assert.equal(result.totalUnits, 3);
  assert.equal(result.totalValue, 35);
  assert.equal(result.priceCoveragePercent, 100);
});

test('unpriced holdings expose known value and coverage instead of a fake total', () => {
  const result = computeFateCollectionValue({
    collectionItems: [item('i1', 'card-a', 2), item('i2', 'card-b', 2)],
    cardValues: [value('card-a', 5)],
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.totalValue, null);
  assert.equal(result.knownValue, 10);
  assert.equal(result.pricedUnits, 2);
  assert.equal(result.unpricedUnits, 2);
  assert.equal(result.priceCoveragePercent, 50);
  assert.equal(result.unpricedItems[0].reason, 'price_evidence_unavailable');
});

test('graded cards are not silently valued with raw-card market evidence', () => {
  const result = computeFateCollectionValue({
    collectionItems: [item('slab-1', 'card-a', 1, { copyState: 'graded' })],
    cardValues: [value('card-a', 20)],
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.totalValue, null);
  assert.equal(result.knownValue, 0);
  assert.equal(result.unpricedItems[0].reason, 'graded_valuation_unavailable');
});

test('latest same-currency raw value wins', () => {
  const result = computeFateCollectionValue({
    collectionItems: [item('i1', 'card-a')],
    cardValues: [
      value('card-a', 10, 100),
      value('card-a', 12, 200),
      { ...value('card-a', 999, 300), currencyCode: 'EUR' },
    ],
    currencyCode: 'GBP',
  });

  assert.equal(result.totalValue, 12);
});
