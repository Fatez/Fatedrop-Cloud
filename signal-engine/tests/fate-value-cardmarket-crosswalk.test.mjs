import test from 'node:test';
import assert from 'node:assert/strict';

import { findCardmarketCrosswalkCandidates } from '../src/trader/value/cardmarket-crosswalk.mjs';

const PRODUCT = Object.freeze({
  sourceName: 'cardmarket',
  sourceRecordId: '668227',
  name: 'Pikachu ex',
});

function card(overrides = {}) {
  return {
    id: 'fdcard_a',
    fateCardId: 'fdcard_a',
    printingId: 'fdprinting_a',
    name: 'Pikachu ex',
    collectorNumber: '123',
    variantCode: 'standard',
    languageCode: 'en',
    verificationStatus: 'verified',
    ...overrides,
  };
}

test('unique exact-name candidate still cannot auto-create a mapping', () => {
  const result = findCardmarketCrosswalkCandidates(PRODUCT, [card()]);

  assert.equal(result.status, 'candidate');
  assert.equal(result.autoMappable, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].fateCardId, 'fdcard_a');
  assert.match(result.reason, /manual_confirmation_required/);
});

test('same printing with several verified variants requires explicit variant confirmation', () => {
  const result = findCardmarketCrosswalkCandidates(PRODUCT, [
    card(),
    card({ id: 'fdcard_b', fateCardId: 'fdcard_b', variantCode: 'reverse-holo' }),
  ]);

  assert.equal(result.status, 'candidate');
  assert.equal(result.autoMappable, false);
  assert.equal(result.printingGroups.length, 1);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.reason, 'printing_identified_variant_confirmation_required');
});

test('same name across several printings is ambiguous rather than guessed', () => {
  const result = findCardmarketCrosswalkCandidates(PRODUCT, [
    card(),
    card({
      id: 'fdcard_b',
      fateCardId: 'fdcard_b',
      printingId: 'fdprinting_b',
      collectorNumber: '124',
    }),
  ]);

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.printingGroups.length, 2);
  assert.equal(result.candidates.length, 2);
});

test('unverified identities are invisible to crosswalk rehearsal', () => {
  const result = findCardmarketCrosswalkCandidates(PRODUCT, [
    card({ verificationStatus: 'staged' }),
  ]);

  assert.equal(result.status, 'unresolved');
  assert.equal(result.candidates.length, 0);
});

test('name normalization may identify candidates but never upgrades confidence', () => {
  const result = findCardmarketCrosswalkCandidates({
    ...PRODUCT,
    name: 'Pikachu  EX',
  }, [card({ name: 'Pikachu ex' })]);

  assert.equal(result.status, 'candidate');
  assert.equal(result.autoMappable, false);
});

test('crosswalk rehearsal refuses non-Cardmarket evidence', () => {
  assert.throws(() => findCardmarketCrosswalkCandidates({
    ...PRODUCT,
    sourceName: 'tcgdex',
  }, [card()]), /must be Cardmarket catalogue evidence/);
});
