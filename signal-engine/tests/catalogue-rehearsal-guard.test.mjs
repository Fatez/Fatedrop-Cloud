import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRehearsalTarget, assertRehearsalCounts } from '../src/trader/catalogue/rehearsal-guard.mjs';
const local = 'postgresql://postgres:postgres@localhost:5432/fatedrop_catalogue_rehearsal';
test('rehearsal accepts only its disposable localhost database', () => {
  validateRehearsalTarget(local);
  for (const bad of [undefined, local.replace('localhost', 'production.neon.tech'), local.replace('5432', '5433'), local.replace('fatedrop_catalogue_rehearsal', 'neondb'), local + '?host=production.neon.tech'])
    assert.throws(() => validateRehearsalTarget(bad));
});
test('saved counts and referential integrity gate rehearsal completion', () => {
  const good = { verified_sets: 132, verified_identities: 20000, orphan_sets: 0, orphan_printings: 0, orphan_mappings: 0, duplicate_identities: 0 };
  assertRehearsalCounts(good);
  for (const bad of [{verified_sets:131}, {verified_identities:17312}, {orphan_sets:1}, {orphan_printings:1}, {orphan_mappings:1}, {duplicate_identities:1}])
    assert.throws(() => assertRehearsalCounts({...good,...bad}));
});
