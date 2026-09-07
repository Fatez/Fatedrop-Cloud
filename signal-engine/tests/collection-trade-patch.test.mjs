import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCollectionItemPatch } from '../src/trader/collection/model.mjs';

test('trade availability preserves graded certification and ownership', () => {
  const grading = { gradingCompany: 'PSA', gradeLabel: '10', gradeValue: 10, certificationNumber: '123', certificationStatus: 'verified', verificationSource: 'grader', verifiedAt: 123456 };
  const current = { fateCardId: 'exact-card', quantity: 1, tradeQuantity: 0, copyState: 'graded', grading, notes: 'My slab' };
  const next = normalizeCollectionItemPatch({ tradeQuantity: 1 }, current);
  assert.equal(next.quantity, 1);
  assert.equal(next.fateCardId, current.fateCardId);
  assert.deepEqual(next.grading, grading);
  assert.equal(next.tradeQuantity, 1);
  assert.deepEqual(current.grading, grading);
});

test('trade availability preserves raw condition and rejects excess copies', () => {
  const current = { fateCardId: 'exact-card', quantity: 3, tradeQuantity: 0, copyState: 'raw', conditionCode: 'lightly_played', grading: null };
  const next = normalizeCollectionItemPatch({ tradeQuantity: 2 }, current);
  assert.equal(next.quantity, 3);
  assert.equal(next.conditionCode, 'lightly_played');
  assert.equal(next.tradeQuantity, 2);
  assert.throws(() => normalizeCollectionItemPatch({ tradeQuantity: 4 }, current), /tradeQuantity/);
});
