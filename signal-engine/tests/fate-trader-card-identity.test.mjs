import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identitiesMatch,
  makeCanonicalCardKey,
  makeFateCardId,
  normaliseCollectorNumber,
  normaliseSourceCardCandidate,
} from '../src/trader/card-identity.mjs';

const baseIdentity = {
  tcgCode: 'pokemon',
  seriesCode: 'scarlet-violet',
  setCode: 'sv03',
  collectorNumber: '215/197',
  printingCode: '215',
  variantCode: 'standard',
  languageCode: 'en',
};

test('canonical card identity is deterministic across harmless formatting differences', () => {
  const a = makeCanonicalCardKey(baseIdentity);
  const b = makeCanonicalCardKey({
    ...baseIdentity,
    tcgCode: ' Pokémon '.replace('é', 'e'),
    seriesCode: 'SCARLET   VIOLET',
    setCode: 'SV03',
    languageCode: 'EN',
  });

  assert.equal(a, b);
  assert.equal(makeFateCardId(a), makeFateCardId(b));
});

test('purely numeric collector numbers ignore source zero-padding', () => {
  assert.equal(normaliseCollectorNumber('001'), '1');
  assert.equal(normaliseCollectorNumber('000'), '0');
  assert.equal(
    makeFateCardId({ ...baseIdentity, collectorNumber: '001' }),
    makeFateCardId({ ...baseIdentity, collectorNumber: '1' }),
  );
});

test('alphanumeric and denominator-bearing collector numbers preserve meaningful formatting', () => {
  assert.equal(normaliseCollectorNumber('SVP001'), 'svp001');
  assert.equal(normaliseCollectorNumber('001/165'), '001/165');
  assert.notEqual(
    makeFateCardId({ ...baseIdentity, collectorNumber: 'SVP001' }),
    makeFateCardId({ ...baseIdentity, collectorNumber: 'SVP1' }),
  );
});

test('variant and language are identity-bearing fields', () => {
  const standardEnglish = makeFateCardId(baseIdentity);
  const reverseEnglish = makeFateCardId({ ...baseIdentity, variantCode: 'reverse-holo' });
  const standardJapanese = makeFateCardId({ ...baseIdentity, languageCode: 'ja' });

  assert.notEqual(standardEnglish, reverseEnglish);
  assert.notEqual(standardEnglish, standardJapanese);
});

test('condition and grade do not change canonical printed identity', () => {
  const raw = makeFateCardId({ ...baseIdentity, condition: 'near-mint' });
  const graded = makeFateCardId({ ...baseIdentity, condition: 'mint', grade: '10', grader: 'psa' });

  assert.equal(raw, graded);
});

test('different upstream sources converge on the same FateDrop card identity', () => {
  const one = normaliseSourceCardCandidate({
    ...baseIdentity,
    sourceName: 'source-a',
    sourceRecordId: 'abc-123',
    name: 'Example ex',
  });
  const two = normaliseSourceCardCandidate({
    ...baseIdentity,
    sourceName: 'source-b',
    sourceRecordId: 'xyz-999',
    name: 'Example ex',
  });

  assert.equal(one.canonicalKey, two.canonicalKey);
  assert.equal(one.fateCardId, two.fateCardId);
  assert.equal(one.verificationStatus, 'staged');
});

test('shared normaliser canonicalizes numeric collector number before persistence', () => {
  const row = normaliseSourceCardCandidate({
    ...baseIdentity,
    collectorNumber: '001',
    sourceName: 'source-a',
    sourceRecordId: 'abc-001',
    name: 'Example',
  });
  assert.equal(row.collectorNumber, '1');
  assert.ok(row.canonicalKey.includes(':1:'));
});

test('shared normaliser fails closed when variant is missing', () => {
  assert.throws(
    () => normaliseSourceCardCandidate({
      ...baseIdentity,
      variantCode: undefined,
      sourceName: 'source-a',
      sourceRecordId: 'abc-123',
      name: 'Example ex',
    }),
    /variantCode is required/,
  );
});

test('shared normaliser fails closed when language is missing', () => {
  assert.throws(
    () => normaliseSourceCardCandidate({
      ...baseIdentity,
      languageCode: undefined,
      sourceName: 'source-a',
      sourceRecordId: 'abc-123',
      name: 'Example ex',
    }),
    /languageCode is required/,
  );
});

test('identity comparison uses canonical structure rather than display name', () => {
  assert.equal(identitiesMatch(baseIdentity, { ...baseIdentity }), true);
  assert.equal(identitiesMatch(baseIdentity, { ...baseIdentity, collectorNumber: '216/197' }), false);
});
