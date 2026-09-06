import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFateCollectorIntelligence } from '../src/trader/collection/collection-intelligence.mjs';

const cards = [
  { fateCardId:'card-a', name:'Alpha', tcgCode:'pokemon', setId:'set-a', setName:'Set A', collectorNumber:'1', rarity:'Rare', variantCode:'standard', languageCode:'en' },
  { fateCardId:'card-b', name:'Beta', tcgCode:'pokemon', setId:'set-b', setName:'Set B', collectorNumber:'2', rarity:'Rare', variantCode:'standard', languageCode:'en' },
  { fateCardId:'card-c', name:'Gamma', tcgCode:'one-piece', setId:'set-c', setName:'Set C', collectorNumber:'3', rarity:'Rare', variantCode:'standard', languageCode:'en' },
];

function price(cardIdentityId, amount, movementPercent) {
  return {
    cardIdentityId,
    available:true,
    price:{ amount, currencyCode:'GBP' },
    movement:{
      d7:{ available:true, percent:movementPercent },
      d30:{ available:true, percent:movementPercent },
    },
  };
}

test('collection intelligence values raw holdings once and groups the same records by set', () => {
  const result = buildFateCollectorIntelligence({
    collectionItems:[
      { fateCardId:'card-a', quantity:2, status:'active', copyState:'raw' },
      { fateCardId:'card-b', quantity:1, status:'active', copyState:'raw' },
      { fateCardId:'card-c', quantity:1, status:'active', copyState:'raw' },
      { fateCardId:'card-a', quantity:1, status:'active', copyState:'graded' },
    ],
    cards,
    prices:[price('card-a',12,20),price('card-b',8,-20)],
    currencyCode:'GBP',
  });

  assert.equal(result.schemaVersion, 'collector-intelligence:1');
  assert.equal(result.scope, 'owned_raw_cards_only');
  assert.equal(result.snapshot.totalCopies, 4);
  assert.equal(result.snapshot.pricedCopies, 3);
  assert.equal(result.snapshot.priceCoveragePercent, 75);
  assert.equal(result.snapshot.currentKnownValue, 32);
  assert.equal(result.snapshot.setsRepresented, 3);
  assert.equal(result.cards.find((row) => row.cardIdentityId === 'card-a').currentKnownValue, 24);
  assert.equal(result.sets.find((row) => row.setId === 'set-a').currentKnownValue, 24);
  assert.equal(result.periods.d30.baselineValue, 30);
  assert.equal(result.periods.d30.currentValue, 32);
  assert.equal(result.periods.d30.movementAmount, 2);
  assert.equal(result.periods.d30.movementPercent, 6.7);
  assert.equal(result.evidence.acquisitionCostUsed, false);
});

test('portfolio history keeps stored market days and reports changing evidence coverage', () => {
  const result = buildFateCollectorIntelligence({
    collectionItems:[
      { fateCardId:'card-a', quantity:2, copyState:'raw' },
      { fateCardId:'card-b', quantity:1, copyState:'raw' },
    ],
    cards,
    prices:[price('card-a',12,20),price('card-b',8,-20)],
    histories:[
      { cardIdentityId:'card-a', available:true, points:[{marketDay:'2026-08-01',amount:10},{marketDay:'2026-08-02',amount:12}] },
      { cardIdentityId:'card-b', available:true, points:[{marketDay:'2026-08-02',amount:8}] },
    ],
    currencyCode:'GBP',
  });

  assert.equal(result.history.status, 'available');
  assert.equal(result.history.pointPolicy, 'stored_market_days_only_no_interpolation');
  assert.equal(result.history.currentValueCoveragePercent, 100);
  assert.deepEqual(result.history.points, [
    { marketDay:'2026-08-01', knownValue:20, pricedCopies:2, totalCopies:3, coveragePercent:66.7 },
    { marketDay:'2026-08-02', knownValue:32, pricedCopies:3, totalCopies:3, coveragePercent:100 },
  ]);
});

test('missing history and prices stay building or unknown instead of becoming zero movement', () => {
  const result = buildFateCollectorIntelligence({
    collectionItems:[{ fateCardId:'card-c', quantity:1, copyState:'raw' }],
    cards,
    prices:[],
    histories:[],
    currencyCode:'GBP',
  });

  assert.equal(result.snapshot.status, 'unavailable');
  assert.equal(result.cards[0].currentKnownValue, null);
  assert.equal(result.periods.d30.status, 'building');
  assert.equal(result.periods.d30.movementPercent, null);
  assert.equal(result.history.status, 'building');
});

test('duplicate raw lots become one quantity-weighted card identity and one concentration slot', () => {
  const result = buildFateCollectorIntelligence({
    collectionItems:[
      { fateCardId:'card-a', quantity:2, copyState:'raw', conditionCode:'near_mint' },
      { fateCardId:'card-a', quantity:3, copyState:'raw', conditionCode:'played' },
      { fateCardId:'card-b', quantity:1, copyState:'raw' },
    ],
    cards,
    prices:[price('card-a',100,10),price('card-b',10,10)],
    currencyCode:'GBP',
  });

  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0].cardIdentityId, 'card-a');
  assert.equal(result.cards[0].quantity, 5);
  assert.equal(result.cards[0].currentKnownValue, 500);
  assert.equal(result.snapshot.topFiveValue, 510);
  assert.equal(result.evidence.concentrationIdentityPolicy, 'unique_exact_card_identity_with_quantity_weighted_value');
});
