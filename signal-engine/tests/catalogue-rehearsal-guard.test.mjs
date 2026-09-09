import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRehearsalTarget, assertRehearsalCounts } from '../src/trader/catalogue/rehearsal-guard.mjs';
const local = 'postgresql://postgres:postgres@localhost:5432/fatedrop_catalogue_rehearsal';
const evidence = { matchedSets: 132, completedSets: 132, intentionalQuarantineSets: 8, unexplainedZeroSavedSetIds: [] };

test('rehearsal accepts only its disposable localhost database', () => {
  validateRehearsalTarget(local);
  for (const bad of [undefined, local.replace('localhost', 'production.neon.tech'), local.replace('5432', '5433'), local.replace('fatedrop_catalogue_rehearsal', 'neondb'), local + '?host=production.neon.tech'])
    assert.throws(() => validateRehearsalTarget(bad));
});

test('saved counts reconcile with deliberate first-edition quarantine and integrity gates', () => {
  const good = { verified_sets: 124, verified_identities: 24059, orphan_sets: 0, orphan_printings: 0, orphan_mappings: 0, duplicate_identities: 0 };
  assertRehearsalCounts(good, evidence);
  for (const [counts, changedEvidence] of [
    [{...good, verified_sets:123}, evidence],
    [{...good, verified_identities:17312}, evidence],
    [{...good, orphan_sets:1}, evidence],
    [{...good, orphan_printings:1}, evidence],
    [{...good, orphan_mappings:1}, evidence],
    [{...good, duplicate_identities:1}, evidence],
    [good, {...evidence, matchedSets:131}],
    [good, {...evidence, completedSets:131}],
    [good, {...evidence, unexplainedZeroSavedSetIds:['cel25cc']}],
  ]) assert.throws(() => assertRehearsalCounts(counts, changedEvidence));
});
