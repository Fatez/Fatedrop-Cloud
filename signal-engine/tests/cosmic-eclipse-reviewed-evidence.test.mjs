import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewedDecisionManifest } from '../src/trader/value/reviewed-finish-decision-cli.mjs';
import { buildCosmicEclipseReviewedInput, COSMIC_ECLIPSE_STANDARD_IDS } from '../evidence/reviews/cosmic-eclipse-standard-finish-2026-09-13.mjs';

test('Cosmic Eclipse reviewed evidence resolves the exact 82-row frozen cohort safely', () => {
  const input = buildCosmicEclipseReviewedInput();
  const output = buildReviewedDecisionManifest(input);

  assert.equal(COSMIC_ECLIPSE_STANDARD_IDS.length, 82);
  assert.equal(new Set(COSMIC_ECLIPSE_STANDARD_IDS).size, 82);
  assert.equal(output.decisions.length, 82);
  assert.equal(output.decisions.filter(row => row.verdict === 'exists').length, 1);
  assert.equal(output.decisions.filter(row => row.verdict === 'does_not_exist').length, 81);

  const rosa = output.decisions.find(row => row.cardIdentityId === 'fdcard_afc95d93fe5308dcf6a06ca8');
  assert.equal(rosa?.verdict, 'exists');
  assert.equal(rosa?.finish, 'standard');

  for (const row of input.reviews.filter(row => row.verdict === 'does_not_exist')) {
    assert.equal(row.basis, 'exact_printing_checklist');
    assert.equal(row.evidencePayload.completeness.checklistComplete, true);
    assert.equal(row.evidencePayload.completeness.sealedProductDecklistsCovered, true);
    assert.equal(row.evidencePayload.completeness.paginationComplete, true);
    assert.equal(row.evidencePayload.completeness.alternateDistributionCovered, true);
  }

  assert.equal(output.policy.priceWritesRemainCardmarketIngestOnly, true);
  assert.equal(output.policy.noBaseCardDeletes, true);
});
