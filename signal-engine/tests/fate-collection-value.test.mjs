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

function value(fateCardId, amount, observedAt = 100, valuationKind = 'raw-market') {
  return {
    fateCardId,
    amount,
    currencyCode: 'GBP',
    observedAt,
    valuationKind,
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
  assert.equal(result.knownValue,35);
  assert.equal(result.fairValue,null);
  assert.equal(result.valuationBasis,'known-price');
  assert.equal(result.priceCoveragePercent, 100);
});

test('Fair Price wins over raw Known Price for the same exact card',()=>{
  const result=computeFateCollectionValue({
    collectionItems:[item('i1','card-a',2)],
    cardValues:[
      value('card-a',12,300,'raw-market'),
      value('card-a',10,200,'fair-price'),
    ],
    currencyCode:'GBP',
  });
  assert.equal(result.totalValue,20);
  assert.equal(result.fairValue,20);
  assert.equal(result.valuationBasis,'fair-price');
  assert.equal(result.fairPricedUnits,2);
  assert.equal(result.knownPricedUnits,0);
});

test('mixed Fair and Known Price coverage is never labelled a full Fair Value',()=>{
  const result=computeFateCollectionValue({
    collectionItems:[item('i1','card-a'),item('i2','card-b')],
    cardValues:[value('card-a',10,100,'fair-price'),value('card-b',5,100,'raw-market')],
    currencyCode:'GBP',
  });
  assert.equal(result.totalValue,15);
  assert.equal(result.fairValue,null);
  assert.equal(result.knownValue,15);
  assert.equal(result.valuationBasis,'mixed');
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

test('latest same-currency value wins within the same valuation kind', () => {
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
