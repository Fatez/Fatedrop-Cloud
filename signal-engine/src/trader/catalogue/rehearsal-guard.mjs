export function validateRehearsalTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A local rehearsal database is required'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost'
    || url.port !== '5432' || url.pathname !== '/fatedrop_catalogue_rehearsal'
    || url.search || url.hash) throw new Error('Rehearsal writes are restricted to the disposable localhost database');
}

export function assertRehearsalCounts(counts, evidence = {}) {
  for (const key of ['verified_sets','printings','verified_identities','source_mappings','orphan_sets','orphan_printings','orphan_mappings','duplicate_identities'])
    if (!Number.isInteger(counts?.[key]) || counts[key] < 0) throw new Error('Rehearsal counts must be explicit non-negative integers');

  for (const key of ['matchedSets','completedSets','intentionalQuarantineSets'])
    if (!Number.isInteger(evidence?.[key]) || evidence[key] < 0) throw new Error('Rehearsal evidence counts must be explicit non-negative integers');
  if (!Array.isArray(evidence?.unexplainedZeroSavedSetIds)) throw new Error('Unexplained zero-saved set evidence is required');

  if (evidence.matchedSets < 132 || evidence.completedSets !== evidence.matchedSets)
    throw new Error('Rehearsal did not traverse the full verified crosswalk');
  if (evidence.unexplainedZeroSavedSetIds.length)
    throw new Error('Rehearsal has unexplained zero-saved sets: ' + evidence.unexplainedZeroSavedSetIds.join(', '));
  if (counts.verified_sets !== evidence.matchedSets)
    throw new Error('Saved set coverage does not reconcile with the verified crosswalk');
  if (evidence.intentionalQuarantineSets > counts.verified_sets)
    throw new Error('Intentional identity quarantine evidence exceeds saved set coverage');
  if (counts.printings < counts.verified_sets)
    throw new Error('Rehearsal did not persist a usable printing catalogue');
  if (counts.source_mappings !== counts.verified_identities)
    throw new Error('Rehearsal source mappings do not reconcile with verified identities');
  if (counts.verified_identities <= 17312)
    throw new Error('Rehearsal did not expand beyond the verified production identity baseline');
  if (counts.orphan_sets || counts.orphan_printings || counts.orphan_mappings || counts.duplicate_identities)
    throw new Error('Rehearsal identity integrity check failed');
}
