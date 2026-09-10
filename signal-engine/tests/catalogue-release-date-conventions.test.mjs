import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSetEvidence } from '../src/trader/catalogue/reconcile.mjs';

function setEvidence({
  sourceName,
  sourceRecordId,
  setName = 'Burning Shadows',
  seriesName = 'Sun & Moon',
  releasedAt,
  printedTotal = 147,
  total = 169,
} = {}) {
  return {
    sourceName,
    sourceRecordId,
    sourceSeriesCode: seriesName,
    sourceUrl: `https://example.test/${sourceRecordId}`,
    languageCode: 'en',
    tcgCode: 'pokemon',
    seriesName,
    setName,
    releasedAt,
    printedTotal,
    total,
  };
}

test('reviewed exact source release-date convention remains matchable and auditable', () => {
  const left = setEvidence({
    sourceName: 'tcgdex',
    sourceRecordId: 'sm3',
    releasedAt: 1501804800000,
  });
  const right = setEvidence({
    sourceName: 'pokemontcg-api',
    sourceRecordId: 'sm3',
    releasedAt: 1501891200000,
  });

  const result = reconcileSetEvidence(left, right);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.acceptedDifferences, [{
    field: 'releasedAt',
    left: 1501804800000,
    right: 1501891200000,
    reason: 'reviewed_source_release_date_convention',
  }]);
});

test('an unreviewed release-date difference still fails closed', () => {
  const left = setEvidence({
    sourceName: 'tcgdex',
    sourceRecordId: 'sm3',
    releasedAt: 1501804800000,
  });
  const right = setEvidence({
    sourceName: 'pokemontcg-api',
    sourceRecordId: 'sm3',
    releasedAt: 1501977600000,
  });

  const result = reconcileSetEvidence(left, right);
  assert.deepEqual(result, {
    status: 'conflict',
    field: 'releasedAt',
    left: 1501804800000,
    right: 1501977600000,
  });
});

test('reviewed release-date convention does not bypass later identity anchors', () => {
  const left = setEvidence({
    sourceName: 'tcgdex',
    sourceRecordId: 'sm3',
    releasedAt: 1501804800000,
    printedTotal: 147,
  });
  const right = setEvidence({
    sourceName: 'pokemontcg-api',
    sourceRecordId: 'sm3',
    releasedAt: 1501891200000,
    printedTotal: 148,
  });

  const result = reconcileSetEvidence(left, right);
  assert.deepEqual(result, {
    status: 'conflict',
    field: 'printedTotal',
    left: 147,
    right: 148,
  });
});
