import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFateCollectorSummary } from '../src/trader/collection/collector-summary.mjs';

const sets = [
  { id: 'set-a', name: 'Set A', tcgCode: 'pokemon', total: 2, printedTotal: 2 },
  { id: 'set-b', name: 'Set B', tcgCode: 'one-piece', total: 2, printedTotal: 2 },
];

const canonicalCards = [
  { id: 'a1-standard', fateCardId: 'a1-standard', printingId: 'a1', setId: 'set-a', tcgCode: 'pokemon', collectorNumber: '1', name: 'A One', verificationStatus: 'verified', variantCode: 'standard', languageCode: 'en' },
  { id: 'a2-standard', fateCardId: 'a2-standard', printingId: 'a2', setId: 'set-a', tcgCode: 'pokemon', collectorNumber: '2', name: 'A Two', verificationStatus: 'verified', variantCode: 'standard', languageCode: 'en' },
  { id: 'b1-standard', fateCardId: 'b1-standard', printingId: 'b1', setId: 'set-b', tcgCode: 'one-piece', collectorNumber: '1', name: 'B One', verificationStatus: 'verified', variantCode: 'standard', languageCode: 'en' },
  { id: 'b2-standard', fateCardId: 'b2-standard', printingId: 'b2', setId: 'set-b', tcgCode: 'one-piece', collectorNumber: '2', name: 'B Two', verificationStatus: 'verified', variantCode: 'standard', languageCode: 'en' },
];

const collectionItems = [
  { id: 'i-a1', fateCardId: 'a1-standard', quantity: 1, status: 'active', copyState: 'raw' },
  { id: 'i-b1', fateCardId: 'b1-standard', quantity: 2, status: 'active', copyState: 'raw' },
  { id: 'i-b2', fateCardId: 'b2-standard', quantity: 1, status: 'active', copyState: 'raw' },
];

const exactCardValues = [
  { fateCardId: 'a1-standard', amount: 10, currencyCode: 'GBP', observedAt: 100, valuationKind: 'raw-market' },
  { fateCardId: 'b1-standard', amount: 5, currencyCode: 'GBP', observedAt: 100, valuationKind: 'raw-market' },
  { fateCardId: 'b2-standard', amount: 7, currencyCode: 'GBP', observedAt: 100, valuationKind: 'raw-market' },
];

const printingValues = [
  { printingId: 'a1', amount: 10, currencyCode: 'GBP', observedAt: 100 },
  { printingId: 'a2', amount: 20, currencyCode: 'GBP', observedAt: 100 },
  { printingId: 'b1', amount: 5, currencyCode: 'GBP', observedAt: 100 },
  { printingId: 'b2', amount: 7, currencyCode: 'GBP', observedAt: 100 },
];

test('collector summary returns portfolio, game breakdowns, set completion and missing values', () => {
  const result = computeFateCollectorSummary({
    sets,
    canonicalCards,
    collectionItems,
    exactCardValues,
    printingValues,
    currencyCode: 'GBP',
    preferredLanguageCode: 'en',
  });

  assert.equal(result.collection.totalValue, 27);
  assert.equal(result.cardUnits, 4);
  assert.equal(result.setsOwned, 2);
  assert.equal(result.progressAvailableSetCount,2);
  assert.equal(result.closestSet.setId, 'set-a');
  assert.equal(result.closestSet.completionPercent, 50);
  assert.equal(result.closestSet.missingCount, 1);

  const pokemon=result.games.find((game)=>game.tcgCode==='pokemon');
  assert.equal(pokemon.collection.totalValue,10);
  assert.equal(pokemon.cardUnits,1);
  assert.equal(pokemon.setsOwned,1);
  assert.equal(pokemon.closestSet.setId,'set-a');
  assert.equal(pokemon.closestSet.completionPercent,50);

  const onePiece=result.games.find((game)=>game.tcgCode==='one-piece');
  assert.equal(onePiece.collection.totalValue,17);
  assert.equal(onePiece.cardUnits,3);
  assert.equal(onePiece.setsOwned,1);
  assert.equal(onePiece.closestSet.setId,'set-b');
  assert.equal(onePiece.closestSet.completionPercent,100);

  const setA = result.sets.find((row) => row.setId === 'set-a');
  assert.equal(setA.ownedCount, 1);
  assert.equal(setA.missingCount, 1);
  assert.equal(setA.value.fullSetValue, 30);
  assert.equal(setA.value.ownedValue, 10);
  assert.equal(setA.value.missingValue, 20);
  assert.equal(setA.missingCards[0].collectorNumber, '2');

  const setB = result.sets.find((row) => row.setId === 'set-b');
  assert.equal(setB.completionPercent, 100);
  assert.equal(setB.value.ownedValue, 12);
  assert.equal(setB.value.missingValue, 0);
});

test('owned set counts survive unavailable checklist progress instead of disappearing', () => {
  const result = computeFateCollectorSummary({
    sets: [{ id: 'set-a', name: 'Set A', tcgCode: 'pokemon', total: 3, printedTotal: 3 }],
    canonicalCards: canonicalCards.filter((card) => card.setId === 'set-a'),
    collectionItems,
    exactCardValues,
    printingValues,
    currencyCode: 'GBP',
  });

  assert.equal(result.setsOwned,1,'the user still owns cards from the set even while completion is unavailable');
  assert.equal(result.progressAvailableSetCount,0);
  assert.equal(result.unavailableSetCount, 1);
  assert.equal(result.sets[0].status, 'unavailable');
  assert.equal(result.sets[0].reason, 'canonical_checklist_incomplete');
  assert.equal(result.games[0].tcgCode,'pokemon');
  assert.equal(result.games[0].setsOwned,1);
  assert.equal(result.games[0].unavailableSetCount,1);
});
