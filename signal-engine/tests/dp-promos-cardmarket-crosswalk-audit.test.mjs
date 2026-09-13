import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exactFinishPresent,
  reviewedIdentityDigest,
} from '../src/trader/value/dp-promos-cardmarket-crosswalk-audit-cli.mjs';

test('reviewed identity digest is deterministic across row order and case-normalises text', () => {
  const a = [
    { name: 'Torterra', collectorNumber: 'DP09', variantCode: 'holo' },
    { name: 'Tropical Wind', collectorNumber: 'dp05', variantCode: 'standard' },
  ];
  const b = [
    { name: ' tropical wind ', collectorNumber: 'DP05', variantCode: 'STANDARD' },
    { name: 'TORTERRA', collectorNumber: 'dp09', variantCode: 'HOLO' },
  ];
  assert.equal(reviewedIdentityDigest(a), reviewedIdentityDigest(b));
});

test('exact finish proof requires an explicit matching pinned TCGdex variant type', () => {
  const card = { variants: [{ type: 'holo' }] };
  assert.equal(exactFinishPresent(card, 'holo'), true);
  assert.equal(exactFinishPresent(card, 'standard'), false);
});

test('missing or unsupported finish evidence fails closed', () => {
  assert.equal(exactFinishPresent({ variants: [] }, 'holo'), false);
  assert.equal(exactFinishPresent({}, 'standard'), false);
  assert.equal(exactFinishPresent({ variants: [{ type: 'holo' }] }, 'reverse'), false);
});
