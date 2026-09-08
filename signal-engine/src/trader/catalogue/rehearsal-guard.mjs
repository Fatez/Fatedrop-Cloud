export function validateRehearsalTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A local rehearsal database is required'); }
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost'
    || url.port !== '5432' || url.pathname !== '/fatedrop_catalogue_rehearsal'
    || url.search || url.hash) throw new Error('Rehearsal writes are restricted to the disposable localhost database');
}

export function assertRehearsalCounts(counts) {
  for (const key of ['verified_sets','verified_identities','orphan_sets','orphan_printings','orphan_mappings','duplicate_identities'])
    if (!Number.isInteger(counts?.[key]) || counts[key] < 0) throw new Error('Rehearsal counts must be explicit non-negative integers');
  if (counts.verified_sets < 132 || counts.verified_identities <= 17312)
    throw new Error('Rehearsal did not reach the required saved catalogue counts');
  if (counts.orphan_sets || counts.orphan_printings || counts.orphan_mappings || counts.duplicate_identities)
    throw new Error('Rehearsal identity integrity check failed');
}
