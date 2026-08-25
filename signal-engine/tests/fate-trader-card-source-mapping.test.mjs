import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSourceCardCandidate } from '../src/trader/card-identity.mjs';

const base = {
  tcgCode: 'pokemon',
  seriesCode: 'scarlet-violet',
  setCode: 'sv03',
  collectorNumber: '215/197',
  printingCode: '215',
  languageCode: 'en',
  sourceName: 'example-source',
  sourceRecordId: 'sv03-215',
  name: 'Example ex',
};

test('one upstream record can safely map to multiple explicit variants', () => {
  const standard = normaliseSourceCardCandidate({ ...base, variantCode: 'standard' });
  const reverse = normaliseSourceCardCandidate({ ...base, variantCode: 'reverse-holo' });

  assert.equal(standard.sourceRecordId, reverse.sourceRecordId);
  assert.equal(standard.sourceVariantKey, 'standard');
  assert.equal(reverse.sourceVariantKey, 'reverse-holo');
  assert.notEqual(standard.fateCardId, reverse.fateCardId);
});

test('adapter may provide a source-specific variant discriminator without changing canonical identity', () => {
  const a = normaliseSourceCardCandidate({
    ...base,
    variantCode: 'reverse-holo',
    sourceVariantKey: 'reverse',
  });
  const b = normaliseSourceCardCandidate({
    ...base,
    variantCode: 'reverse-holo',
    sourceVariantKey: 'rev-holo-flag',
  });

  assert.equal(a.fateCardId, b.fateCardId);
  assert.notEqual(a.sourceVariantKey, b.sourceVariantKey);
});
