export function validateRehearsalTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A local rehearsal database is required'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost'
    || url.port !== '5432' || url.pathname !== '/fatedrop_catalogue_rehearsal'
    || url.search || url.hash) throw new Error('Rehearsal writes are restricted to the disposable localhost database');
}

export function assertRehearsalCounts(counts, evidence = {}) {
  for (const key of ['verified_sets','verified_identities','orphan_sets','orphan_printings','orphan_mappings','duplicate_identities'])
    if (!Number.isInteger(counts?.[key]) || counts[key] < 0) throw new Error('Rehearsal counts must be explicit non-negative integers');

  for (const key of ['matchedSets','completedSets','intentionalQuarantineSets'])
    if (!Number.isInteger(evidence?.[key]) || evidence[key] < 0) throw new Error('Rehearsal evidence counts must be explicit non-negative integers');
  if (!Array.isArray(evidence?.unexplainedZeroSavedSetIds)) throw new Error('Unexplained zero-saved set evidence is required');

  if (evidence.matchedSets < 132 || evidence.completedSets !== evidence.matchedSets)
    throw new Error('Rehearsal did not traverse the full verified crosswalk');
  if (evidence.unexplainedZeroSavedSetIds.length)
    throw new Error('Rehearsal has unexplained zero-saved sets: ' + evidence.unexplainedZeroSavedSetIds.join(', '));
  if (counts.verified_sets + evidence.intentionalQuarantineSets !== evidence.matchedSets)
    throw new Error('Saved set coverage does not reconcile with intentional quarantine policy');
  if (counts.verified_identities <= 17312)
    throw new Error('Rehearsal did not expand beyond the verified production identity baseline');
  if (counts.orphan_sets || counts.orphan_printings || counts.orphan_mappings || counts.duplicate_identities)
    throw new Error('Rehearsal identity integrity check failed');
}
