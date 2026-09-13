import test from 'node:test';
import assert from 'node:assert/strict';
import { combineCandidates } from '../src/trader/value/cardmarket-section-b-activation-cli.mjs';

const a = { cardIdentityId: 'a', sourceRecordId: '1', sourceVariantKey: 'normal' };
const b = { cardIdentityId: 'b', sourceRecordId: '2', sourceVariantKey: 'holo' };

test('combines distinct primary and secondary candidates', () => {
  const rows = combineCandidates([a], [b]);
  assert.equal(rows.length, 2);
});

test('rejects duplicate canonical identity across recovery lanes', () => {
  assert.throws(() => combineCandidates([a], [{ ...b, cardIdentityId: 'a' }]), /Duplicate canonical identity/);
});

test('rejects duplicate Cardmarket source lane across recovery lanes', () => {
  assert.throws(() => combineCandidates([a], [{ ...b, sourceRecordId: '1', sourceVariantKey: 'normal' }]), /Duplicate Cardmarket source key/);
});
