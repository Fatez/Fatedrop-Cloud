import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessBaselineFinishEvidence,
  rootProductNameMatches,
} from '../src/trader/value/cardmarket-tcgdex-root-evidence.mjs';

test('root ID alone never proves standard finish when TCGdex has no variants', () => {
  const result = assessBaselineFinishEvidence({ variants: [] }, 'standard', 12345);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_baseline_target_variant');
});

test('normal baseline proves standard but not holo', () => {
  const card = {
    variants: [
      { type: 'normal', subtype: null, foil: null, stamp: [], cardmarketProductId: 12345 },
    ],
  };
  const standard = assessBaselineFinishEvidence(card, 'standard', 12345);
  assert.equal(standard.ok, true);
  assert.equal(standard.policy.sourceVariantKey, 'normal');

  const holo = assessBaselineFinishEvidence(card, 'holo', 12345);
  assert.equal(holo.ok, false);
  assert.equal(holo.reason, 'no_baseline_target_variant');
});

test('stamped and special-foil variants do not count as baseline finish evidence', () => {
  const stamped = assessBaselineFinishEvidence({
    variants: [{ type: 'normal', subtype: null, foil: null, stamp: ['league'], cardmarketProductId: 12345 }],
  }, 'standard', 12345);
  assert.equal(stamped.ok, false);

  const specialFoil = assessBaselineFinishEvidence({
    variants: [{ type: 'holo', subtype: null, foil: 'cosmos', stamp: [], cardmarketProductId: 12345 }],
  }, 'holo', 12345);
  assert.equal(specialFoil.ok, false);
});

test('explicit baseline product disagreement with root ID fails closed', () => {
  const result = assessBaselineFinishEvidence({
    variants: [{ type: 'normal', subtype: null, foil: null, stamp: [], cardmarketProductId: 99999 }],
  }, 'standard', 12345);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'baseline_target_product_disagrees_with_root');
});

test('multiple explicit baseline product IDs fail closed', () => {
  const result = assessBaselineFinishEvidence({
    variants: [
      { type: 'normal', subtype: null, foil: null, stamp: [], cardmarketProductId: 12345 },
      { type: 'normal', subtype: null, foil: null, stamp: [], cardmarketProductId: 67890 },
    ],
  }, 'standard', 12345);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'multiple_baseline_target_product_ids');
});

test('known provider-only naming decorations remain compatible', () => {
  assert.equal(rootProductNameMatches('M Gardevoir EX', 'MGardevoir EX [Brilliant Arrow | Link Blast]'), true);
  assert.equal(rootProductNameMatches('Suicune ☆', 'Suicune Gold Star'), true);
  assert.equal(rootProductNameMatches('Nidoran ♀', 'Nidoran [F]'), true);
  assert.equal(rootProductNameMatches('Nidoran ♀', 'Nidoran [M]'), false);
});
