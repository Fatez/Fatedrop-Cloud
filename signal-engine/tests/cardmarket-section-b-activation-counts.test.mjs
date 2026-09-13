import test from 'node:test';
import assert from 'node:assert/strict';

test('pinned Section B recovery arithmetic remains exact', () => {
  const primary = 470;
  const secondary = 27;
  assert.equal(primary + secondary, 497);
  assert.equal(1222 - 497, 725);
  assert.equal(560 - 27, 533);
});
