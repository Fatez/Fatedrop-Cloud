import test from 'node:test';
import assert from 'node:assert/strict';

import { positiveCentralFields, verifyExactTargetLane } from '../src/trader/value/reviewed-residual-28-finish-lane-cli.mjs';

test('standard approval uses only standard central Cardmarket fields', () => {
  const row = { trend: 1.25, avg7: 1.2, 'trend-holo': 9.99, 'avg7-holo': 9.5 };
  assert.deepEqual(positiveCentralFields(row, 'standard'), ['trend', 'avg7']);
  const result = verifyExactTargetLane({ variantCode: 'standard', priceLane: 'standard', sourceVariantKey: 'normal' }, row);
  assert.equal(result.approved, true);
  assert.equal(result.priceLane, 'standard');
  assert.deepEqual(result.positiveCentralFields, ['trend', 'avg7']);
});

test('holo approval requires an explicit positive holo central lane', () => {
  const baseOnly = { trend: 3.5, avg30: 3.1, 'trend-holo': 0, 'avg7-holo': null };
  const rejected = verifyExactTargetLane({ variantCode: 'holo', priceLane: 'holo', sourceVariantKey: 'holo' }, baseOnly);
  assert.equal(rejected.approved, false);
  assert.equal(rejected.reason, 'NO_POSITIVE_CENTRAL_VALUE_IN_EXACT_TARGET_LANE');

  const withHolo = { trend: 3.5, 'trend-holo': 12.25, 'avg30-holo': 11.8 };
  const approved = verifyExactTargetLane({ variantCode: 'holo', priceLane: 'holo', sourceVariantKey: 'holo' }, withHolo);
  assert.equal(approved.approved, true);
  assert.deepEqual(approved.positiveCentralFields, ['trend-holo', 'avg30-holo']);
});

test('finish, lane and source variant must agree exactly', () => {
  const row = { trend: 2, 'trend-holo': 4 };
  assert.equal(verifyExactTargetLane({ variantCode: 'standard', priceLane: 'holo', sourceVariantKey: 'normal' }, row).approved, false);
  assert.equal(verifyExactTargetLane({ variantCode: 'standard', priceLane: 'standard', sourceVariantKey: 'holo' }, row).approved, false);
  assert.equal(verifyExactTargetLane({ variantCode: 'reverse', priceLane: 'standard', sourceVariantKey: 'normal' }, row).approved, false);
});
