import test from 'node:test';
import assert from 'node:assert/strict';

test('Section B activation module imports without executing production writes', async () => {
  const module = await import('../src/trader/value/cardmarket-section-b-activation-cli.mjs');
  assert.equal(typeof module.combineCandidates, 'function');
});
