import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEWED_SWSH_PROMO_BASE_LANE,
  REVIEWED_SWSH_PROMO_BASE_LANE_PRODUCT_IDS,
  isReviewedSwshPromoBaseLaneProduct,
  validateReviewedSwshPromoBaseLaneMappings,
} from '../src/trader/value/cardmarket-reviewed-swsh-promo-base-lane.mjs';

function rows() {
  return REVIEWED_SWSH_PROMO_BASE_LANE.map((entry) => ({
    id: entry.mappingId,
    card_identity_id: entry.cardIdentityId,
    source_name: 'cardmarket',
    source_record_id: entry.sourceRecordId,
    source_variant_key: 'holo',
    canonical_variant_code: 'holo',
    language_code: 'en',
    verification_status: 'verified',
  }));
}

test('reviewed SWSH promo base-lane manifest is exactly eight unique products', () => {
  assert.equal(REVIEWED_SWSH_PROMO_BASE_LANE.length, 8);
  assert.equal(new Set(REVIEWED_SWSH_PROMO_BASE_LANE_PRODUCT_IDS).size, 8);
  for (const id of REVIEWED_SWSH_PROMO_BASE_LANE_PRODUCT_IDS) assert.equal(isReviewedSwshPromoBaseLaneProduct(id), true);
  assert.equal(isReviewedSwshPromoBaseLaneProduct('not-reviewed'), false);
});

test('exact frozen mappings validate as one all-or-nothing reviewed cohort', () => {
  assert.deepEqual(
    [...validateReviewedSwshPromoBaseLaneMappings(rows())].sort(),
    [...REVIEWED_SWSH_PROMO_BASE_LANE_PRODUCT_IDS].sort(),
  );
});

test('identity, finish, language or verification drift fails closed', () => {
  for (const field of ['card_identity_id','source_variant_key','canonical_variant_code','language_code','verification_status']) {
    const changed = rows();
    changed[0] = { ...changed[0], [field]: 'drift' };
    assert.equal(validateReviewedSwshPromoBaseLaneMappings(changed).size, 0, field);
  }
});

test('mapping id drift fails closed', () => {
  const changed = rows();
  changed[0] = { ...changed[0], id: 'fdcardmap_changed' };
  assert.equal(validateReviewedSwshPromoBaseLaneMappings(changed).size, 0);
});
