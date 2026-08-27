import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeExchangeAgreement } from '../src/trader/safe-exchange/protocol.mjs';

function agreementFor(asset) {
  return createSafeExchangeAgreement({
    transactionId: 'ftx-card-state-test',
    partyAUserId: 'user-a',
    partyBUserId: 'user-b',
    method: 'postal',
    partyACommitment: { assets: [asset] },
    partyBCommitment: { cashPence: 100 },
  });
}

test('raw Safe Exchange cards require an explicit canonical raw condition', () => {
  const missing = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1, copyState: 'raw' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes('party_a_condition_invalid'));

  const valid = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1, copyState: 'raw', conditionCode: 'near_mint' });
  assert.equal(valid.ok, true);
  assert.equal(valid.agreement.partyACommitment.assets[0].conditionCode, 'near_mint');
});

test('graded Safe Exchange cards require explicit grading company/value and one physical copy', () => {
  const vague = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1, copyState: 'graded' });
  assert.equal(vague.ok, false);
  assert.ok(vague.errors.includes('party_a_grading_company_missing'));
  assert.ok(vague.errors.includes('party_a_grade_invalid'));

  const many = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 2, copyState: 'graded', gradingCompany: 'PSA', gradeValue: 10 });
  assert.equal(many.ok, false);
  assert.ok(many.errors.includes('party_a_graded_quantity_invalid'));

  const valid = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1, copyState: 'graded', gradingCompany: 'PSA', gradeValue: 10 });
  assert.equal(valid.ok, true);
});

test('Safe Exchange rejects ambiguous or contradictory card-state claims', () => {
  const unspecified = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1 });
  assert.equal(unspecified.ok, false);
  assert.ok(unspecified.errors.includes('party_a_copy_state_invalid'));

  const contradictoryRaw = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1, copyState: 'raw', conditionCode: 'near_mint', gradingCompany: 'PSA', gradeValue: 10 });
  assert.equal(contradictoryRaw.ok, false);
  assert.ok(contradictoryRaw.errors.includes('party_a_raw_grading_not_allowed'));

  const contradictoryGraded = agreementFor({ collectionItemId: 'item-a', fateCardId: 'card-a', quantity: 1, copyState: 'graded', conditionCode: 'near_mint', gradingCompany: 'PSA', gradeValue: 10 });
  assert.equal(contradictoryGraded.ok, false);
  assert.ok(contradictoryGraded.errors.includes('party_a_graded_condition_not_allowed'));
});
