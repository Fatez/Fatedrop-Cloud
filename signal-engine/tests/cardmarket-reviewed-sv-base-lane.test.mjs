import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEWED_SV_BASE_LANE,
  REVIEWED_SV_BASE_LANE_MANIFEST_DIGEST,
  REVIEWED_SV_BASE_LANE_PRODUCT_IDS,
  isReviewedSvBaseLaneProduct,
  validateReviewedSvBaseLaneMappings,
} from '../src/trader/value/cardmarket-reviewed-sv-base-lane.mjs';

function rows() {
  return REVIEWED_SV_BASE_LANE.map((entry) => ({
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

test('reviewed Scarlet & Violet Base manifest is exactly 70 unique products', () => {
  assert.equal(REVIEWED_SV_BASE_LANE.length, 70);
  assert.equal(REVIEWED_SV_BASE_LANE_MANIFEST_DIGEST, '16dd420a9de2c0c1e2e1ace0e9aa1e915aa84f3bf8a8cf197b2e0e67bc414eb9');
  assert.equal(new Set(REVIEWED_SV_BASE_LANE_PRODUCT_IDS).size, 70);
  for (const id of REVIEWED_SV_BASE_LANE_PRODUCT_IDS) assert.equal(isReviewedSvBaseLaneProduct(id), true);
  assert.equal(isReviewedSvBaseLaneProduct('not-reviewed'), false);
});

test('exact frozen mappings validate as one all-or-nothing reviewed cohort', () => {
  assert.deepEqual(
    [...validateReviewedSvBaseLaneMappings(rows())].sort(),
    [...REVIEWED_SV_BASE_LANE_PRODUCT_IDS].sort(),
  );
});

test('identity, finish, language or verification drift fails closed', () => {
  for (const field of ['card_identity_id','source_variant_key','canonical_variant_code','language_code','verification_status']) {
    const changed = rows();
    changed[0] = { ...changed[0], [field]: 'drift' };
    assert.equal(validateReviewedSvBaseLaneMappings(changed).size, 0, field);
  }
});

test('mapping id drift fails closed', () => {
  const changed = rows();
  changed[0] = { ...changed[0], id: 'fdcardmap_changed' };
  assert.equal(validateReviewedSvBaseLaneMappings(changed).size, 0);
});

test('Professor Research releases are collector-pinned and only 240/241 are included', () => {
  const professors = REVIEWED_SV_BASE_LANE.filter((row) => row.name === "Professor's Research");
  assert.deepEqual(professors.map((row) => row.collectorNumber), ['240','241']);
  assert.ok(professors.every((row) => row.proof === 'professor_label_sole_ordinary_holo_finish'));
  assert.equal(REVIEWED_SV_BASE_LANE.some((row) => row.collectorNumber === '189'), false);
  assert.equal(REVIEWED_SV_BASE_LANE.some((row) => row.collectorNumber === '190'), false);
});
