import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFateSetValue } from '../src/trader/value/set-value.mjs';

function card(printingId) {
  return {
    id: `card-${printingId}`,
    setId: 'set-1',
    printingId,
    verificationStatus: 'verified',
  };
}

const set = { id: 'set-1', total: 3, printedTotal: 3 };
const canonicalCards = [card('p1'), card('p2'), card('p3')];

function value(printingId, amount, observedAt = 100, valuationKind = 'raw-market') {
  return {
    printingId,
    amount,
    currencyCode: 'GBP',
    observedAt,
    valuationKind,
    sourceName: 'test-market',
  };
}

test('Fate Set Value returns full, owned and missing Known totals when every checklist card is raw-market priced', () => {
  const result = computeFateSetValue({
    set,
    canonicalCards,
    printingValues: [value('p1', 1.25), value('p2', 2.5), value('p3', 3.75)],
    ownedPrintingIds: ['p1', 'p3'],
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'available');
  assert.equal(result.priceCoveragePercent, 100);
  assert.equal(result.fullSetValue, 7.5);
  assert.equal(result.fairSetValue,null);
  assert.equal(result.valuationBasis,'known-price');
  assert.equal(result.ownedValue, 5);
  assert.equal(result.missingValue, 2.5);
  assert.equal(result.ownedExpectedCount, 2);
  assert.equal(result.missingExpectedCount, 1);
});

test('complete calibrated Fair Price coverage exposes Fair Set, owned and missing values',()=>{
  const result=computeFateSetValue({
    set,
    canonicalCards,
    printingValues:[
      value('p1',1,100,'fair-price'),
      value('p2',2,100,'fair-price'),
      value('p3',3,100,'fair-price'),
    ],
    ownedPrintingIds:['p1','p3'],
    currencyCode:'GBP',
  });
  assert.equal(result.valuationBasis,'fair-price');
  assert.equal(result.fairSetValue,6);
  assert.equal(result.fairOwnedValue,4);
  assert.equal(result.fairMissingValue,2);
});

test('Fair Price wins over newer raw Known Price for the same checklist printing',()=>{
  const result=computeFateSetValue({
    set,
    canonicalCards,
    printingValues:[
      value('p1',10,100,'fair-price'),value('p1',99,300,'raw-market'),
      value('p2',20,100,'fair-price'),
      value('p3',30,100,'fair-price'),
    ],
    ownedPrintingIds:[],
    currencyCode:'GBP',
  });
  assert.equal(result.fullSetValue,60);
  assert.equal(result.fairSetValue,60);
  assert.equal(result.valuationBasis,'fair-price');
});

test('mixed valuation basis is never labelled full Fair Set Value',()=>{
  const result=computeFateSetValue({
    set,
    canonicalCards,
    printingValues:[value('p1',10,100,'fair-price'),value('p2',20),value('p3',30)],
    ownedPrintingIds:[],
    currencyCode:'GBP',
  });
  assert.equal(result.fullSetValue,60);
  assert.equal(result.fairSetValue,null);
  assert.equal(result.valuationBasis,'mixed');
});

test('partial set pricing never masquerades known sums as complete owned or full-set value', () => {
  const result = computeFateSetValue({
    set,
    canonicalCards,
    printingValues: [value('p1', 10), value('p2', 20)],
    ownedPrintingIds: ['p1', 'p3'],
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.fullSetValue, null);
  assert.equal(result.knownSetValue, 30);
  assert.equal(result.ownedValue, null);
  assert.equal(result.knownOwnedValue, 10);
  assert.equal(result.ownedPriceCoveragePercent, 50);

  // The only missing card is p2 and it is priced, so that slice is complete
  // even though the full set and owned slice are not.
  assert.equal(result.missingValue, 20);
  assert.equal(result.missingPriceCoveragePercent, 100);
  assert.deepEqual(result.unpricedPrintingIds, ['p3']);
});

test('latest same-currency value wins within the same valuation kind and other currencies are not mixed', () => {
  const result = computeFateSetValue({
    set,
    canonicalCards,
    printingValues: [
      value('p1', 1, 100),
      value('p1', 4, 200),
      { ...value('p1', 999, 300), currencyCode: 'EUR' },
      value('p2', 2, 200),
      value('p3', 3, 200),
    ],
    ownedPrintingIds: [],
    currencyCode: 'GBP',
  });

  assert.equal(result.fullSetValue, 9);
  assert.equal(result.ownedValue, 0);
  assert.equal(result.missingValue, 9);
});

test('set valuation fails closed before pricing when canonical checklist is incomplete', () => {
  const result = computeFateSetValue({
    set,
    canonicalCards: canonicalCards.slice(0, 2),
    printingValues: [value('p1', 10), value('p2', 20)],
    ownedPrintingIds: ['p1'],
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'canonical_checklist_incomplete');
  assert.equal(result.fullSetValue, null);
  assert.equal(result.ownedValue, null);
  assert.equal(result.missingValue, null);
});
