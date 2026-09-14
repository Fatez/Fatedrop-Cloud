import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEWED_SV_BASE_LANE,
  REVIEWED_SV_BASE_LANE_MANIFEST_DIGEST,
  REVIEWED_SV_BASE_LANE_PRODUCT_IDS,
  isReviewedSvBaseLaneProduct,
  validateReviewedSvBaseLaneMapping,
  validateReviewedSvBaseLaneMappings,
} from '../src/trader/value/cardmarket-reviewed-sv-base-lane.mjs';

const EXPECTED_LANE_LENGTH = 70;
const EXPECTED_MANIFEST_DIGEST = '16dd420a9de2c0c1e2e1ace0e9aa1e915aa84f3bf8a8cf197b2e0e67bc414eb9';

function duplicateProductIds(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
}

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

test('reviewed Scarlet & Violet Base laneLength is frozen at 70', () => {
  const laneLength = REVIEWED_SV_BASE_LANE.length;
  assert.equal(laneLength, EXPECTED_LANE_LENGTH, `laneLength=${laneLength}`);
});

test('reviewed Scarlet & Violet Base productIdsLength is frozen at 70', () => {
  const productIdsLength = REVIEWED_SV_BASE_LANE_PRODUCT_IDS.length;
  assert.equal(productIdsLength, EXPECTED_LANE_LENGTH, `productIdsLength=${productIdsLength}`);
});

test('reviewed Scarlet & Violet Base uniqueProductIds is frozen at 70', () => {
  const uniqueProductIds = new Set(REVIEWED_SV_BASE_LANE_PRODUCT_IDS).size;
  const duplicateIds = duplicateProductIds(REVIEWED_SV_BASE_LANE_PRODUCT_IDS);
  assert.equal(
    uniqueProductIds,
    EXPECTED_LANE_LENGTH,
    `uniqueProductIds=${uniqueProductIds}; duplicateIds=${JSON.stringify(duplicateIds)}`,
  );
});

test('reviewed Scarlet & Violet Base duplicateIds remains empty', () => {
  const duplicateIds = duplicateProductIds(REVIEWED_SV_BASE_LANE_PRODUCT_IDS);
  assert.deepEqual(duplicateIds, [], `duplicateIds=${JSON.stringify(duplicateIds)}`);
});

test('reviewed Scarlet & Violet Base frozenDigest remains unchanged', () => {
  assert.equal(
    REVIEWED_SV_BASE_LANE_MANIFEST_DIGEST,
    EXPECTED_MANIFEST_DIGEST,
    `frozenDigest=${REVIEWED_SV_BASE_LANE_MANIFEST_DIGEST}`,
  );
});

test('reviewed Scarlet & Violet Base product lookup accepts only the frozen product IDs', () => {
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


test('single-card eligibility does not require the full production cohort', () => {
  const [first] = rows();
  assert.equal(validateReviewedSvBaseLaneMapping(first), true);
  assert.equal(validateReviewedSvBaseLaneMapping({ ...first, card_identity_id: 'drift' }), false);
  assert.equal(validateReviewedSvBaseLaneMappings([first]).size, 0);
});
