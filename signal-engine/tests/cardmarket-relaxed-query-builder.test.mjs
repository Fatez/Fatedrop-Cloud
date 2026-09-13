import test from 'node:test';
import assert from 'node:assert/strict';
import { relaxedComparableName } from '../src/trader/value/cardmarket-relaxed-secondary-recovery-cli.mjs';

test('relaxed discovery normalizes punctuation without changing canonical finish', () => {
  assert.equal(relaxedComparableName('Arceus LV.X'), relaxedComparableName('Arceus LV X'));
  assert.equal(relaxedComparableName('Nidoran♀'), relaxedComparableName('Nidoran female'));
});
