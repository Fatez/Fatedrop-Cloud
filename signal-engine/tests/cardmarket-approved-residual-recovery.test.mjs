import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distinctExplicitCardmarketProductIds,
  hasSupportedCentralCardmarketLane,
  providerDescriptorIsUniqueSubset,
  providerDescriptorTerms,
} from '../src/trader/value/cardmarket-approved-residual-recovery-cli.mjs';

test('one explicit Cardmarket product across multiple TCGdex variants remains deterministic', () => {
  const ids = distinctExplicitCardmarketProductIds({ variants: [
    { type: 'normal', cardmarketProductId: 123 },
    { type: 'reverse', cardmarketProductId: 123 },
    { type: 'holo', cardmarketProductId: 123 },
  ] });
  assert.deepEqual(ids, [123]);
});

test('multiple explicit Cardmarket product ids remain ambiguous', () => {
  const ids = distinctExplicitCardmarketProductIds({ variants: [
    { type: 'holo', cardmarketProductId: 123 },
    { type: 'holo', cardmarketProductId: 124 },
  ] });
  assert.deepEqual(ids, [123, 124]);
});

test('low-only Cardmarket data is not a supported central Fate Price', () => {
  assert.equal(hasSupportedCentralCardmarketLane({ low: 0.25, avg: 0.31 }, 'standard'), false);
  assert.equal(hasSupportedCentralCardmarketLane({ 'low-holo': 0.25, 'avg-holo': 0.31 }, 'holo'), false);
});

test('trend and rolling averages count as supported central pricing', () => {
  assert.equal(hasSupportedCentralCardmarketLane({ trend: 1.25 }, 'standard'), true);
  assert.equal(hasSupportedCentralCardmarketLane({ 'avg30-holo': 2.5 }, 'holo'), true);
});

test('provider descriptor terms can be a strict subset of exact card attack evidence', () => {
  const terms = providerDescriptorTerms('Dustox [Flap | Wind Shard]');
  assert.deepEqual(terms, ['flap', 'wind shard']);
  assert.equal(providerDescriptorIsUniqueSubset(terms, ['flap', 'plus', 'wind shard']), true);
});

test('descriptor subset rejects a provider term absent from exact TCGdex evidence', () => {
  const terms = providerDescriptorTerms('Dustox [Flap | Twilight Poison]');
  assert.equal(providerDescriptorIsUniqueSubset(terms, ['flap', 'plus', 'wind shard']), false);
});

test('numeric provider discriminator is ignored as a descriptor term', () => {
  assert.deepEqual(providerDescriptorTerms('Bulbasaur [Leech Seed | 151]'), ['leech seed']);
});
