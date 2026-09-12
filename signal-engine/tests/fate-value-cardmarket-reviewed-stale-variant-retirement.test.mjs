import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEWED_BASELINE_HOLO_PRODUCT_IDS,
  REVIEWED_STALE_VARIANT_PLAN_DIGEST,
  REVIEWED_STALE_VARIANT_RETIREMENTS,
  REVIEWED_STALE_VARIANT_TCGDEX_REVISION,
  reviewedStaleVariantPlanDigest,
  validateReviewedStaleVariantPlan,
} from '../src/trader/value/cardmarket-reviewed-stale-variant-retirement.mjs';

test('reviewed stale Cardmarket variant retirement plan is frozen and exact', () => {
  assert.equal(REVIEWED_STALE_VARIANT_TCGDEX_REVISION, '5b6a2859f454972477a9953ffe5cb554d24c45e9');
  assert.equal(REVIEWED_STALE_VARIANT_RETIREMENTS.length, 58);
  assert.equal(REVIEWED_STALE_VARIANT_RETIREMENTS.filter((row) => row.kind === 'stamped_holo').length, 56);
  assert.equal(REVIEWED_STALE_VARIANT_RETIREMENTS.filter((row) => row.kind === 'competing_normal').length, 2);
  assert.equal(REVIEWED_BASELINE_HOLO_PRODUCT_IDS.length, 42);
  assert.equal(new Set(REVIEWED_BASELINE_HOLO_PRODUCT_IDS).size, 42);
  assert.equal(new Set(REVIEWED_STALE_VARIANT_RETIREMENTS.map((row) => row.mappingId)).size, 58);
  assert.equal(reviewedStaleVariantPlanDigest(), REVIEWED_STALE_VARIANT_PLAN_DIGEST);
  assert.equal(validateReviewedStaleVariantPlan(), true);
});

test('reviewed stamped mappings remain distinct from their retained baseline holo products', () => {
  const stamped = REVIEWED_STALE_VARIANT_RETIREMENTS.filter((row) => row.kind === 'stamped_holo');
  for (const row of stamped) {
    assert.equal(row.sourceVariantKey, 'holo');
    assert.ok(row.stamp.length > 0);
    assert.notEqual(row.sourceRecordId, row.retainedProductId);
    assert.notEqual(row.mappingId, row.retainedMappingId);
    assert.ok(REVIEWED_BASELINE_HOLO_PRODUCT_IDS.includes(row.retainedProductId));
  }
});

test('reviewed competing-normal retirements are only the two previously held 91-policy products', () => {
  const rows = REVIEWED_STALE_VARIANT_RETIREMENTS.filter((row) => row.kind === 'competing_normal');
  assert.deepEqual(rows.map((row) => row.sourceRecordId).sort(), ['568801', '760792']);
  for (const row of rows) {
    assert.equal(row.sourceVariantKey, 'normal');
    assert.equal(row.stamp, '');
    assert.equal(row.sourceRecordId, row.retainedProductId);
    assert.notEqual(row.mappingId, row.retainedMappingId);
  }
});

test('plan integrity fails closed when a reviewed row changes', () => {
  const tampered = REVIEWED_STALE_VARIANT_RETIREMENTS.map((row, index) => index === 0 ? { ...row, sourceRecordId: '0' } : row);
  assert.notEqual(reviewedStaleVariantPlanDigest(tampered), REVIEWED_STALE_VARIANT_PLAN_DIGEST);
});
