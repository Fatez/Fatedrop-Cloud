import test from 'node:test';
import assert from 'node:assert/strict';

import { computeFateCollectorMovement } from '../src/trader/collection/collector-movement.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function summary({ collection = 100, fullSet = 120, owned = 100, missing = 20, missingCard=20 } = {}) {
  return {
    collection: { totalValue: collection },
    games:[{tcgCode:'pokemon',collection:{totalValue:collection}}],
    sets: [{
      setId: 'set_1',
      setName: 'Test Set',
      tcgCode: 'pokemon',
      value: { fullSetValue: fullSet, ownedValue: owned, missingValue: missing },
      missingCards:[{
        fateCardId:'card_2',printingId:'printing_2',name:'Missing Card',collectorNumber:'2',
        fatePrice:missingCard==null?null:{amount:missingCard,currencyCode:'EUR'},
      }],
    }],
  };
}

test('calculates 7D/30D collection, game, set and missing-card movement from the same current holdings', () => {
  const result = computeFateCollectorMovement({
    currentSummary: summary({ collection: 120, fullSet: 150, owned: 120, missing: 30, missingCard:30 }),
    sevenDaySummary: summary({ collection: 100, fullSet: 125, owned: 100, missing: 25, missingCard:25 }),
    thirtyDaySummary: summary({ collection: 80, fullSet: 100, owned: 80, missing: 20, missingCard:20 }),
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
  assert.equal(result.sevenDay.games[0].tcgCode,'pokemon');
  assert.equal(result.sevenDay.games[0].collection.amountChange,20);
  assert.equal(result.sevenDay.sets[0].value.fullSet.amountChange, 25);
  assert.equal(result.sevenDay.sets[0].value.missing.amountChange, 5);
  assert.equal(result.sevenDay.sets[0].missingCards[0].movement.amountChange,5);
  assert.equal(result.sevenDay.sets[0].missingCards[0].movement.percentChange,20);
  assert.equal(result.thirtyDay.sets[0].missingCards[0].movement.amountChange,10);
  assert.equal(result.thirtyDay.sets[0].missingCards[0].movement.percentChange,50);
});

test('missing historical complete totals or card prices do not manufacture movement', () => {
  const result = computeFateCollectorMovement({
    currentSummary: summary(),
    sevenDaySummary: summary({ collection: null, fullSet: null, owned: null, missing: null, missingCard:null }),
    thirtyDaySummary: null,
    currencyCode: 'EUR',
    currentAsOf: NOW,
    sevenDayAsOf: NOW - 7 * DAY,
    thirtyDayAsOf: NOW - 30 * DAY,
  });

  assert.equal(result.sevenDay.collection.status, 'unavailable');
  assert.equal(result.sevenDay.collection.percentChange, null);
  assert.equal(result.sevenDay.sets[0].missingCards[0].movement.status,'unavailable');
  assert.equal(result.sevenDay.sets[0].missingCards[0].movement.percentChange,null);
  assert.equal(result.thirtyDay.status, 'unavailable');
  assert.equal(result.thirtyDay.reason, 'baseline_summary_unavailable');
});
