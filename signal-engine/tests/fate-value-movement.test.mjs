import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFateValueMovement } from '../src/trader/value/value-movement.mjs';

test('value movement reports real amount and percentage change', () => {
  const result = computeFateValueMovement({
    currentValue: 110,
    baselineValue: 100,
    currencyCode: 'GBP',
    currentAsOf: '2026-09-03',
    baselineAsOf: '2026-08-27',
  });

  assert.equal(result.status, 'available');
  assert.equal(result.amountChange, 10);
  assert.equal(result.percentChange, 10);
  assert.equal(result.currencyCode, 'GBP');
});

test('movement fails closed when either complete valuation is unavailable', () => {
  const result = computeFateValueMovement({
    currentValue: null,
    baselineValue: 100,
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'complete_value_unavailable');
  assert.equal(result.percentChange, null);
});

test('movement does not compare different currencies', () => {
  const result = computeFateValueMovement({
    currentValue: 100,
    baselineValue: 100,
    currencyCode: 'GBP',
    baselineCurrencyCode: 'EUR',
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'currency_mismatch');
});

test('zero baseline keeps absolute change but does not invent an infinite percentage', () => {
  const result = computeFateValueMovement({
    currentValue: 10,
    baselineValue: 0,
    currencyCode: 'GBP',
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.amountChange, 10);
  assert.equal(result.percentChange, null);
});
