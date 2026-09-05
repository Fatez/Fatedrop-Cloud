import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFateGradedCollectionValue } from '../src/trader/value/graded-collection-value.mjs';

const slab = (gradeLabel = '10') => ({
  id: 'slab-1',
  fateCardId: 'card-a',
  quantity: 1,
  copyState: 'graded',
  status: 'active',
  grading: { gradingCompany: 'PSA', gradeLabel },
});

const gradedValue = (gradeLabel, amount) => ({
  fateCardId: 'card-a',
  gradingCompany: 'PSA',
  gradeLabel,
  amount,
  currencyCode: 'GBP',
  observedAt: 100,
  valuationKind: 'graded-market',
});

test('graded valuation requires exact card, grader and grade evidence', () => {
  const result = computeFateGradedCollectionValue({
    collectionItems: [slab('10')],
    gradedValues: [gradedValue('9', 90), gradedValue('10', 150)],
    currencyCode: 'GBP',
  });
  assert.equal(result.totalValue, 150);
  assert.equal(result.priceCoveragePercent, 100);
});

test('graded valuation rejects raw evidence and exposes the gap', () => {
  const result = computeFateGradedCollectionValue({
    collectionItems: [slab()],
    gradedValues: [{ ...gradedValue('10', 150), valuationKind: 'raw-market' }],
    currencyCode: 'GBP',
  });
  assert.equal(result.totalValue, null);
  assert.equal(result.knownValue, 0);
  assert.equal(result.unpricedItems[0].reason, 'graded_price_evidence_unavailable');
});
