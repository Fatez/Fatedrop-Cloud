import test from 'node:test';
import assert from 'node:assert/strict';

import { extractRootTcgplayerProductId } from '../src/trader/value/fateprice-secondary-readiness-audit-cli.mjs';

test('extracts root TCGplayer product id from canonical card evidence', () => {
  const source = `const card: Card = {\n  name: { en: 'Weedle' },\n  thirdParty: { cardmarket: 281340, tcgplayer: 90548 }\n}`;
  assert.equal(extractRootTcgplayerProductId(source), 90548);
});

test('does not confuse variant-level thirdParty ids with the root product id', () => {
  const source = `const card: Card = {\n  name: { en: 'Example' },\n  variants: [ { type: 'Normal', thirdParty: { tcgplayer: 111 } } ],\n  thirdParty: { tcgplayer: 222 }\n}`;
  assert.equal(extractRootTcgplayerProductId(source), 222);
});

test('returns null when root TCGplayer evidence is absent', () => {
  const source = `const card: Card = {\n  name: { en: 'Example' },\n  thirdParty: { cardmarket: 123 }\n}`;
  assert.equal(extractRootTcgplayerProductId(source), null);
});
