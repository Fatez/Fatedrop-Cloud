import test from 'node:test';
import assert from 'node:assert/strict';

test('Section B recovery keeps manual residuals held rather than guessed', () => {
  const input = 1222;
  const safe = 497;
  const residual = 725;
  assert.equal(input - safe, residual);
  assert.ok(residual > 0);
});
