import assert from 'node:assert/strict';
import test from 'node:test';

import { COB_PIP_SINGLE_COLLECTIONS, normalizeCobPipSingleCandidate } from '../src/trader/value/cob-pip-singles-pilot.mjs';
import {
  buildVerifiedRetailSingleRecords,
  resolveExactRetailSingleCandidate,
  resolveRetailSingleBatch,
} from '../src/trader/value/retail-single-offers.mjs';

const binding = COB_PIP_SINGLE_COLLECTIONS['pokemon-chaos-rising'];

function product(title = '#001 Weedle Mega Evolution Chaos Rising') {
  return { id: 100, title, handle: '001-weedle-mega-evolution-chaos-rising', image: { src: 'https://cdn.example/weedle.jpg' } };
}

function variant(title = 'Base', overrides = {}) {
  return { id: 200, title, price: '0.50', available: true, ...overrides };
}

function card(overrides = {}) {
  return {
    id: 'fdcard_weedle_standard',
    fateCardId: 'fdcard_weedle_standard',
    setId: binding.canonicalSetId,
    tcgCode: 'pokemon',
    collectorNumber: '1',
    name: 'Weedle',
    variantCode: 'standard',
    languageCode: 'en',
    verificationStatus: 'verified',
    ...overrides,
  };
}

function candidate(productValue = product(), variantValue = variant()) {
  return normalizeCobPipSingleCandidate(productValue, variantValue, {
    collection: binding,
    observedAt: Date.parse('2026-09-07T12:00:00.000Z'),
  });
}

test('retailer singles resolve only through reviewed set, exact number, name, language and finish', () => {
  const resolved = resolveExactRetailSingleCandidate(candidate(), { binding, canonicalCards: [card()] });
  assert.equal(resolved.status, 'verified');
  assert.equal(resolved.cardIdentityId, 'fdcard_weedle_standard');
  assert.equal(resolved.marketSegmentKey, 'standard');
  assert.equal(resolved.exactIdentityVerified, true);

  const reverse = resolveExactRetailSingleCandidate(candidate(product(), variant('Rev Holo')), {
    binding,
    canonicalCards: [card({ id: 'fdcard_reverse', fateCardId: 'fdcard_reverse', variantCode: 'reverse-holo' })],
  });
  assert.equal(reverse.status, 'verified');
  assert.equal(reverse.marketSegmentKey, 'reverse-holo');
});

test('Base means the one exact base printing, not an invented standard or holo substitution', () => {
  const holo = card({ id: 'fdcard_hooh_holo', fateCardId: 'fdcard_hooh_holo', collectorNumber: '10', name: 'Ho-Oh', variantCode: 'holo' });
  const resolved = resolveExactRetailSingleCandidate(
    candidate(product('#010 Ho-oh Mega Evolution Chaos Rising'), variant('Base', { id: 210 })),
    { binding, canonicalCards: [holo] },
  );
  assert.equal(resolved.status, 'verified');
  assert.equal(resolved.marketSegmentKey, 'holo');

  const conflict = resolveExactRetailSingleCandidate(candidate(), {
    binding,
    canonicalCards: [card(), card({ id: 'fdcard_weedle_holo', fateCardId: 'fdcard_weedle_holo', variantCode: 'holo' })],
  });
  assert.equal(conflict.status, 'quarantined');
  assert.equal(conflict.reason, 'exact_identity_conflict');
});

test('source mistakes and unknown finishes quarantine instead of guessing', () => {
  const wrongName = resolveExactRetailSingleCandidate(
    candidate(product('#001 Definitely Not Weedle Mega Evolution Chaos Rising')),
    { binding, canonicalCards: [card()] },
  );
  assert.equal(wrongName.status, 'quarantined');
  assert.equal(wrongName.reason, 'exact_identity_not_found');

  const unknownFinish = resolveExactRetailSingleCandidate(candidate(product(), variant('Rainbow-ish')), {
    binding,
    canonicalCards: [card()],
  });
  assert.equal(unknownFinish.status, 'quarantined');
  assert.equal(unknownFinish.reason, 'finish_unrecognized');
});

test('reviewed collector-number-scoped aliases may resolve known retailer wording differences', () => {
  const energy = card({ id: 'fdcard_energy', fateCardId: 'fdcard_energy', collectorNumber: '84', name: 'Bubbly Water Energy', variantCode: 'holo' });
  const resolved = resolveExactRetailSingleCandidate(
    candidate(product('#084 Bubbly Energy Mega Evolution Chaos Rising'), variant('Base', { id: 284 })),
    { binding, canonicalCards: [energy] },
  );
  assert.equal(resolved.status, 'verified');
  assert.equal(resolved.evidence.sourceCardName, 'Bubbly Energy');
  assert.equal(resolved.evidence.cardName, 'Bubbly Water Energy');
});

test('a one-variant retailer product resolves only when the exact canonical identity is unique', () => {
  const unique = card({ id: 'fdcard_secret', fateCardId: 'fdcard_secret', collectorNumber: '88', name: 'Froakie', variantCode: 'holo' });
  const resolved = resolveExactRetailSingleCandidate(
    candidate(product('#088 Froakie Mega Evolution Chaos Rising'), variant('Default Title', { id: 288 })),
    { binding, canonicalCards: [unique] },
  );
  assert.equal(resolved.status, 'verified');
  assert.equal(resolved.marketSegmentKey, 'holo');
});

test('verified resolutions become reusable product, offer, observation and crosswalk records', () => {
  const resolved = resolveExactRetailSingleCandidate(candidate(), { binding, canonicalCards: [card()] });
  const records = buildVerifiedRetailSingleRecords(resolved, { now: Date.parse('2026-09-07T12:01:00.000Z') });
  assert.equal(records.product.productType, 'SINGLE');
  assert.equal(records.product.canonicalKey, 'single:fdcard_weedle_standard');
  assert.equal(records.offer.retailerId, 'cob-and-pip');
  assert.equal(records.offer.stockQuantity, null);
  assert.equal(records.mapping.cardIdentityId, 'fdcard_weedle_standard');
  assert.equal(records.mapping.verificationStatus, 'verified');
  assert.equal(records.mapping.marketSegmentKey, 'standard');
});

test('batch resolution reports buyable exact coverage separately from quarantines', () => {
  const result = resolveRetailSingleBatch([
    candidate(),
    candidate(product('#002 Kakuna Mega Evolution Chaos Rising'), variant('Mystery', { id: 202 })),
  ], { binding, canonicalCards: [card()] });
  assert.deepEqual(result.counts, { candidates: 2, verified: 1, quarantined: 1, buyableVerified: 1 });
});
