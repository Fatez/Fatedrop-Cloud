import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMarketPulseDirection } from '../src/trader/value/market-pulse-direction.mjs';

function card({
  id,
  setCode,
  setName,
  expected = 2,
  current,
  d1 = null,
  d7 = null,
  d30 = null,
  sourceVariantKey = 'standard',
} = {}) {
  const movement = (percent) => percent == null
    ? null
    : { amount: current - (current / (1 + (percent / 100))), percent };
  return {
    cardIdentityId: id,
    sourceVariantKey,
    name: `Card ${id}`,
    tcgCode: 'pokemon',
    setCode,
    setName,
    collectorNumber: id,
    expectedCardCount: expected,
    currentPrice: current,
    movement: {
      d1: movement(d1),
      d7: movement(d7),
      d30: movement(d30),
    },
  };
}

test('publishes a median qualifying-set return with explicit breadth, coverage and rankings', () => {
  const cards = [
    card({ id: 'a1', setCode: 'rise', setName: 'Rising Set', current: 60, d1: 20, d7: 20, d30: 20 }),
    card({ id: 'a2', setCode: 'rise', setName: 'Rising Set', current: 60, d1: 20, d7: 20, d30: 20 }),
    card({ id: 'b1', setCode: 'fall', setName: 'Falling Set', current: 40, d1: -20, d7: -20, d30: -20 }),
    card({ id: 'b2', setCode: 'fall', setName: 'Falling Set', current: 40, d1: -20, d7: -20, d30: -20 }),
    card({ id: 'c1', setCode: 'flat', setName: 'Flat Set', current: 50, d1: 0, d7: 0, d30: 0 }),
    card({ id: 'c2', setCode: 'flat', setName: 'Flat Set', current: 50, d1: 0, d7: 0, d30: 0 }),
    card({ id: 'd1', setCode: 'partial', setName: 'Partial Set', current: 25, d1: 25, d7: 25, d30: 25 }),
  ];

  const result = buildMarketPulseDirection({ cards, rankingLimit: 3 });
  const period = result.periods.d7;

  assert.equal(result.schemaVersion, 'market-pulse-direction:1');
  assert.equal(result.method, 'median_qualifying_set_basket_return');
  assert.equal(result.minimumSetCoveragePct, 95);
  assert.equal(period.status, 'available');
  assert.equal(period.reason, null);
  assert.equal(period.condition, 'mixed');
  assert.equal(period.headlinePercent, 0);
  assert.deepEqual(period.breadth, { risingSets: 1, unchangedSets: 1, fallingSets: 1 });
  assert.deepEqual(period.coverage, {
    trackedSets: 4,
    qualifyingSets: 3,
    excludedSets: 1,
    setsWithDeclaredTotals: 4,
    expectedCards: 8,
    pricedCards: 7,
    baselineCards: 7,
    currentPriceCoveragePct: 87.5,
    exactBaselineCoveragePct: 87.5,
  });
  assert.deepEqual(period.setRisers.map((set) => set.setCode), ['rise']);
  assert.deepEqual(period.setDecliners.map((set) => set.setCode), ['fall']);
  assert.deepEqual(period.cardRisers.map((item) => item.cardIdentityId), ['a1', 'a2']);
  assert.deepEqual(period.cardDecliners.map((item) => item.cardIdentityId), ['b1', 'b2']);
  assert.equal(period.setRisers[0].movementPercent, 20);
  assert.equal(period.setDecliners[0].movementPercent, -20);
});

test('fails closed when set totals are absent or exact baseline coverage is insufficient', () => {
  const missingTotals = buildMarketPulseDirection({
    cards: [card({ id: 'a1', setCode: 'unknown', expected: null, current: 10, d7: 10 })],
  }).periods.d7;
  assert.equal(missingTotals.status, 'building');
  assert.equal(missingTotals.reason, 'set_totals_missing');
  assert.equal(missingTotals.condition, 'insufficient_evidence');

  const missingBaseline = buildMarketPulseDirection({
    cards: [
      card({ id: 'a1', setCode: 'partial', current: 10, d7: 10 }),
      card({ id: 'a2', setCode: 'partial', current: 10, d7: null }),
    ],
  }).periods.d7;
  assert.equal(missingBaseline.status, 'building');
  assert.equal(missingBaseline.reason, 'insufficient_set_coverage');
  assert.equal(missingBaseline.coverage.exactBaselineCoveragePct, 50);
});

test('deduplicates canonical identities and does not treat a zero baseline as a percentage return', () => {
  const duplicate = card({ id: 'a1', setCode: 'set-a', expected: 1, current: 11, d1: 10 });
  const duplicateLane = { ...duplicate, sourceVariantKey: 'duplicate-source-lane' };
  const deduplicated = buildMarketPulseDirection({ cards: [duplicateLane, duplicate] }).periods.d1;
  assert.equal(deduplicated.coverage.pricedCards, 1);
  assert.equal(deduplicated.coverage.baselineCards, 1);

  const zeroBaseline = {
    ...card({ id: 'z1', setCode: 'zero', expected: 1, current: 10 }),
    movement: { d1: { amount: 10, percent: null }, d7: null, d30: null },
  };
  const result = buildMarketPulseDirection({ cards: [zeroBaseline] }).periods.d1;
  assert.equal(result.status, 'building');
  assert.equal(result.coverage.baselineCards, 0);
});

test('validates policy inputs rather than silently changing them', () => {
  assert.throws(() => buildMarketPulseDirection({ cards: null }), /cards must be an array/);
  assert.throws(() => buildMarketPulseDirection({ minimumSetCoveragePct: 0 }), /between 0 and 100/);
  assert.throws(() => buildMarketPulseDirection({ rankingLimit: 0 }), /between 1 and 20/);
});
