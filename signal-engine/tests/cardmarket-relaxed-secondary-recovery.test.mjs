import test from 'node:test';
import assert from 'node:assert/strict';

import { relaxedComparableName, chooseRelaxedProduct } from '../src/trader/value/cardmarket-relaxed-secondary-recovery-cli.mjs';

const card = { name: 'Arceus LV.X', sourcePath: '/does/not/exist.ts' };
const set = { cards: [card] };
const identity = { name: 'Arceus LV.X' };

function index(products, expansionId = 77) {
  const byExpansionName = new Map();
  const key = `${expansionId}|${relaxedComparableName('Arceus LV.X')}`;
  byExpansionName.set(key, products);
  return { byExpansionName };
}

test('punctuation normalization treats LV.X and LV X equivalently for candidate discovery', () => {
  assert.equal(relaxedComparableName('Arceus LV.X'), relaxedComparableName('Arceus LV X'));
});

test('accepts one product only when the canonical card name is unique in the scoped set', () => {
  const product = { sourceRecordId: '123', name: 'Arceus LV X' };
  const result = chooseRelaxedProduct({ identity, card, set, scope: { expansionId: 77 }, catalogueIndex: index([product]) });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.product.sourceRecordId, '123');
  assert.equal(result.matchBasis, 'unique_name_within_exact_set_scope');
});

test('fails closed when more than one product survives and descriptor evidence is unavailable', () => {
  const products = [
    { sourceRecordId: '123', name: 'Arceus LV X [Attack One]' },
    { sourceRecordId: '124', name: 'Arceus LV X [Attack Two]' },
  ];
  const result = chooseRelaxedProduct({ identity, card, set, scope: { expansionId: 77 }, catalogueIndex: index(products) });
  assert.equal(result.status, 'HOLD_MULTIPLE_PRODUCTS');
  assert.deepEqual(result.candidates, ['123', '124']);
});

test('fails closed with no candidate in the proven set scope', () => {
  const result = chooseRelaxedProduct({ identity, card, set, scope: { expansionId: 77 }, catalogueIndex: index([]) });
  assert.equal(result.status, 'HOLD_NO_MATCH');
});

test('requires a proven Cardmarket expansion scope', () => {
  const result = chooseRelaxedProduct({ identity, card, set, scope: null, catalogueIndex: index([]) });
  assert.equal(result.status, 'HOLD_EXPANSION_MISMATCH');
});

test('duplicate canonical names are never accepted solely from one provider-name candidate', () => {
  const duplicateSet = { cards: [card, { name: 'Arceus LV.X', sourcePath: '/also/missing.ts' }] };
  const product = { sourceRecordId: '123', name: 'Arceus LV X' };
  const result = chooseRelaxedProduct({ identity, card, set: duplicateSet, scope: { expansionId: 77 }, catalogueIndex: index([product]) });
  assert.equal(result.status, 'HOLD_MULTIPLE_PRODUCTS');
});
