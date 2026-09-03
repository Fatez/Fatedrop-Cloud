import test from 'node:test';
import assert from 'node:assert/strict';

import { computeFateCollectorMovement } from '../src/trader/collection/collector-movement.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function summary({ collection = 100, fullSet = 120, owned = 100, missing = 20 } = {}) {
  return {
    collection: { totalValue: collection },
    sets: [{
      setId: 'set_1',
      setName: 'Test Set',
      tcgCode: 'pokemon',
      value: { fullSetValue: fullSet, ownedValue: owned, missingValue: missing },
    }],
  };
}

test('calculates 7D/30D collection and set movement from same current holdings repriced historically', () => {
  const result = computeFateCollectorMovement({
    currentSummary: summary({ collection: 120, fullSet: 150, owned: 120, missing: 30 }),
    sevenDaySummary: summary({ collection: 100, fullSet: 125, owned: 100, missing: 25 }),
    thirtyDaySummary: summary({ collection: 80, fullSet: 100, owned: 80, missing: 20 }),
    currencyCode: 'EUR',
    currentAsOf: NOW,
    sevenDayAsOf: NOW - 7 * DAY,
    thirtyDayAsOf: NOW - 30 * DAY,
  });

  assert.equal(result.basis, 'current-holdings-repriced');
  assert.equal(result.sevenDay.collection.amountChange, 20);
  assert.equal(result.sevenDay.collection.percentChange, 20);
  assert.equal(result.thirtyDay.collection.amountChange, 40);
  assert.equal(result.thirtyDay.collection.percentChange, 50);
  assert.equal(result.sevenDay.sets[0].value.fullSet.amountChange, 25);
  assert.equal(result.sevenDay.sets[0].value.missing.amountChange, 5);
});

test('missing historical complete totals do not manufacture movement', () => {
  const result = computeFateCollectorMovement({
    currentSummary: summary(),
    sevenDaySummary: summary({ collection: null, fullSet: null, owned: null, missing: null }),
    thirtyDaySummary: null,
    currencyCode: 'EUR',
    currentAsOf: NOW,
    sevenDayAsOf: NOW - 7 * DAY,
    thirtyDayAsOf: NOW - 30 * DAY,
  });

  assert.equal(result.sevenDay.status, 'unavailable');
  assert.equal(result.sevenDay.collection.status, 'unavailable');
  assert.equal(result.sevenDay.collection.percentChange, null);
  assert.equal(result.thirtyDay.status, 'unavailable');
  assert.equal(result.thirtyDay.reason, 'baseline_summary_unavailable');
});
