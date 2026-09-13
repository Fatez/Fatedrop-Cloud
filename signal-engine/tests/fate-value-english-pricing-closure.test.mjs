import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnglishPricingScope,
  buildEnglishPricingClosure,
} from '../src/trader/value/english-pricing-bundle.mjs';

const card = (id, classifierState = null) => ({
  id,
  language_code: 'en',
  verification_status: 'verified',
  variant_code: id.includes('holo') ? 'holo' : 'standard',
  classifier_state: classifierState,
});

test('English pricing scope excludes invalid and unresolved identities without losing accounting', () => {
  const scope = buildEnglishPricingScope([
    card('standard-no-state'),
    card('holo-active-priced', 'ACTIVE_PRICED'),
    card('standard-active-unpriced', 'ACTIVE_UNPRICED'),
    card('holo-invalid', 'INVALID_CATALOGUE_ENTRY'),
    card('standard-unresolved', 'UNRESOLVED_EVIDENCE'),
  ]);

  assert.equal(scope.sourceCardCount, 5);
  assert.equal(scope.eligibleCardCount, 3);
  assert.equal(scope.excludedInvalidCatalogueEntryCount, 1);
  assert.equal(scope.excludedUnresolvedEvidenceCount, 1);
  assert.deepEqual(scope.eligibleCards.map((row) => row.id), [
    'standard-no-state',
    'holo-active-priced',
    'standard-active-unpriced',
  ]);
  assert.equal(
    scope.sourceCardCount,
    scope.eligibleCardCount + scope.excludedInvalidCatalogueEntryCount + scope.excludedUnresolvedEvidenceCount,
  );
});

test('invalid catalogue identities cannot inflate the English unpriced denominator', () => {
  const scope = buildEnglishPricingScope([
    card('standard-1'),
    card('holo-2'),
    card('standard-invalid', 'INVALID_CATALOGUE_ENTRY'),
  ]);
  const closure = buildEnglishPricingClosure({
    scope,
    pricedCount: 1,
    classifications: [{ cardIdentityId:'holo-2', outcome:'unmapped_requires_evidence' }],
    candidateCount: 0,
    stageFailures: [],
  });

  assert.equal(closure.eligibleCardCount, 2);
  assert.equal(closure.pricedCount, 1);
  assert.equal(closure.heldUnpricedCount, 1);
  assert.equal(closure.excludedInvalidCatalogueEntryCount, 1);
  assert.equal(closure.unmappedUnpricedCount, 1);
  assert.equal(closure.status, 'evidence_complete_with_held_residuals');
  assert.equal(closure.coveragePercent, 50);
});

test('closure distinguishes actionable recovery work from evidence-held residuals', () => {
  const scope = buildEnglishPricingScope([card('standard-1'), card('holo-2')]);
  const actionable = buildEnglishPricingClosure({
    scope,
    pricedCount: 1,
    classifications: [{ cardIdentityId:'holo-2', outcome:'mapping_candidate_with_price' }],
    candidateCount: 1,
    stageFailures: [],
  });
  assert.equal(actionable.status, 'actionable_candidates_present');
  assert.equal(actionable.actionableCandidateCount, 1);

  const incomplete = buildEnglishPricingClosure({
    scope,
    pricedCount: 1,
    classifications: [{ cardIdentityId:'holo-2', outcome:'unmapped_requires_evidence' }],
    candidateCount: 0,
    stageFailures: [{ stage:'example', error:'failed' }],
  });
  assert.equal(incomplete.status, 'audit_incomplete');
});

test('pricing scope rejects identities outside the verified English standard/holo contract', () => {
  assert.throws(() => buildEnglishPricingScope([{
    id:'reverse', language_code:'en', verification_status:'verified', variant_code:'reverse-holo', classifier_state:null,
  }]), /verified English standard\/holo/);
});
