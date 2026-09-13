import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedMindsReviewedInput } from '../evidence/reviews/unified-minds-standard-finish-2026-09-13.mjs';
import { buildReviewedDecisionManifest } from '../src/trader/value/reviewed-finish-decision-cli.mjs';

test('Unified Minds finish review stays exact and guarded', () => {
  const input = buildUnifiedMindsReviewedInput(1789299600000);
  assert.equal(input.provider, 'set_rule');
  assert.equal(input.reviews.length, 60);
  assert.equal(new Set(input.reviews.map(row => row.cardIdentityId)).size, 60);
  assert.equal(input.reviews.filter(row => row.verdict === 'exists').length, 1);
  assert.equal(input.reviews.filter(row => row.verdict === 'does_not_exist').length, 59);

  for (const row of input.reviews) {
    assert.equal(row.finish, 'standard');
    assert.equal(row.basis, 'exact_printing_checklist');
    assert.equal(row.evidencePayload.setCode, 'sm11');
  }
  for (const row of input.reviews.filter(row => row.verdict === 'does_not_exist')) {
    assert.equal(row.evidencePayload.completeness.checklistComplete, true);
    assert.equal(row.evidencePayload.completeness.sealedProductDecklistsCovered, true);
    assert.equal(row.evidencePayload.completeness.paginationComplete, true);
    assert.equal(row.evidencePayload.completeness.alternateDistributionCovered, true);
  }

  const reviewed = buildReviewedDecisionManifest(input);
  assert.equal(reviewed.decisions.length, 60);
  assert.equal(reviewed.productionWrites, false);
  assert.equal(reviewed.priceWrites, false);
  assert.equal(reviewed.policy.noBaseCardDeletes, true);
});
