import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewedChecklistCorroboration } from '../src/trader/catalogue/checklist-reviewed-conventions.mjs';

function setMatch(leftSet, rightSet) {
  return {
    status: 'matched',
    evidence: [
      { sourceName: 'tcgdex', sourceRecordId: leftSet },
      { sourceName: 'pokemontcg-api', sourceRecordId: rightSet },
    ],
  };
}

function evidence({ sourceName, sourceSetCode, sourceRecordId, name, collectorNumber }) {
  return {
    sourceName,
    sourceSetCode,
    sourceRecordId,
    name,
    collectorNumber,
    tcgCode: 'pokemon',
    languageCode: 'en',
    printingCode: 'standard',
  };
}

test('reviewed checklist aliases cover only the ten independently evidenced tail records', () => {
  const cases = [
    ['neo4', 'neo4', 'neo4-96', "Thought Wave Machine (Rocket's Secret Machine)", '96', 'neo4-96', 'Thought Wave Machine', '96', 'cardName'],
    ['ecard2', 'ecard2', 'ecard2-50a', 'Golduck', '50a', 'ecard2-50', 'Golduck', '50', 'collectorNumber'],
    ['ecard2', 'ecard2', 'ecard2-50b', 'Golduck', '50b', 'ecard2-50', 'Golduck', '50', 'collectorNumber'],
    ['ecard2', 'ecard2', 'ecard2-74a', 'Drowzee', '74a', 'ecard2-74', 'Drowzee', '74', 'collectorNumber'],
    ['ecard2', 'ecard2', 'ecard2-74b', 'Drowzee', '74b', 'ecard2-74', 'Drowzee', '74', 'collectorNumber'],
    ['ecard2', 'ecard2', 'ecard2-95a', 'Mr. Mime', '95a', 'ecard2-95', 'Mr. Mime', '95', 'collectorNumber'],
    ['ecard2', 'ecard2', 'ecard2-95b', 'Mr. Mime', '95b', 'ecard2-95', 'Mr. Mime', '95', 'collectorNumber'],
    ['ecard2', 'ecard2', 'ecard2-103a', 'Porygon', '103a', 'ecard2-103', 'Porygon', '103', 'collectorNumber'],
    ['ecard2', 'ecard2', 'ecard2-103b', 'Porygon', '103b', 'ecard2-103', 'Porygon', '103', 'collectorNumber'],
    ['sv10.5b', 'zsv10pt5', 'sv10.5b-080', 'Antique Cover Fossil', '080', 'zsv10pt5-80', 'Antique Cover Fossil', '60', 'collectorNumber'],
  ];

  for (const [leftSet, rightSet, leftId, leftName, leftNumber, rightId, rightName, rightNumber, field] of cases) {
    const left = evidence({ sourceName: 'tcgdex', sourceSetCode: leftSet, sourceRecordId: leftId, name: leftName, collectorNumber: leftNumber });
    const right = evidence({ sourceName: 'pokemontcg-api', sourceSetCode: rightSet, sourceRecordId: rightId, name: rightName, collectorNumber: rightNumber });
    const result = reviewedChecklistCorroboration(setMatch(leftSet, rightSet), left, right);
    assert.ok(result, leftId);
    assert.equal(result.acceptedDifferences.length, 1);
    assert.equal(result.acceptedDifferences[0].field, field);
    assert.equal(result.evidence.name, left.name);
    assert.equal(result.evidence.collectorNumber, left.collectorNumber);
  }
});

test('checklist-only conventions fail closed on source drift and do not cover missing SWSH promos', () => {
  const aquapolisLeft = evidence({ sourceName: 'tcgdex', sourceSetCode: 'ecard2', sourceRecordId: 'ecard2-50a', name: 'Golduck', collectorNumber: '50a' });
  const driftedRight = evidence({ sourceName: 'pokemontcg-api', sourceSetCode: 'ecard2', sourceRecordId: 'ecard2-50', name: 'Golduck', collectorNumber: '51' });
  assert.equal(reviewedChecklistCorroboration(setMatch('ecard2', 'ecard2'), aquapolisLeft, driftedRight), null);

  const promoLeft = evidence({ sourceName: 'tcgdex', sourceSetCode: 'swshp', sourceRecordId: 'swshp-SWSH299', name: 'Jirachi V', collectorNumber: 'SWSH299' });
  const inventedPromo = evidence({ sourceName: 'pokemontcg-api', sourceSetCode: 'swshp', sourceRecordId: 'swshp-SWSH299', name: 'Jirachi V', collectorNumber: 'SWSH299' });
  assert.equal(reviewedChecklistCorroboration(setMatch('swshp', 'swshp'), promoLeft, inventedPromo), null);
});
