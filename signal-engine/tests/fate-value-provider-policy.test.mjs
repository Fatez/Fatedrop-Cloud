import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFatePriceProviderApproved,
  getFatePriceProviderPolicy,
} from '../src/trader/value/provider-policy.mjs';

test('Cardmarket public downloads are the approved Cardmarket ingestion path', () => {
  const policy = assertFatePriceProviderApproved('cardmarket-public-download');
  assert.equal(policy.status, 'approved');
  assert.equal(policy.acquisitionMode, 'public-download');
});

test('Pokemon Wizard is blocked without written permission', () => {
  assert.equal(getFatePriceProviderPolicy('pokemon-wizard').status, 'blocked');
  assert.throws(
    () => assertFatePriceProviderApproved('pokemon-wizard'),
    (error) => error.code === 'PRICING_SOURCE_BLOCKED',
  );
});

test('restricted APIs fail closed until explicit approval exists', () => {
  for (const key of ['tcgplayer-api', 'cardmarket-api']) {
    assert.throws(
      () => assertFatePriceProviderApproved(key),
      (error) => error.code === 'PRICING_SOURCE_APPROVAL_REQUIRED',
    );
  }
  assert.throws(
    () => assertFatePriceProviderApproved('mystery-provider'),
    (error) => error.code === 'PRICING_SOURCE_UNREVIEWED',
  );
});
