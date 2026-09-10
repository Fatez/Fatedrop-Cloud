// A source record and a finish-specific canonical identity are different units.
export function buildPrimaryCoverageLedger(census, mappings) {
  if (census?.format !== 'fatedrop-primary-source-census-v1' || !Array.isArray(census.cards) || !census.revision) throw new Error('Pinned primary census required');
  if (!Array.isArray(mappings)) throw new Error('Explicit mapping rows required');
  const bySource = new Map();
  const sourceIds = new Set();
  for (const row of census.cards) {
    if (!row.id || sourceIds.has(row.id)) throw new Error('Duplicate/missing census source ID');
    sourceIds.add(row.id);
  }
  const identityKeys = new Map();
  for (const row of mappings) {
    if (row.sourceName !== 'tcgdex') continue;
    if (!row.sourceRecordId || !row.cardIdentityId || !row.variantCode || !row.languageCode || !row.canonicalKey) throw new Error('Incomplete exact mapping row');
    const prior = identityKeys.get(row.canonicalKey);
    if (prior && prior !== row.cardIdentityId) throw new Error('Duplicate canonical identity');
    identityKeys.set(row.canonicalKey, row.cardIdentityId);
    const rows = bySource.get(row.sourceRecordId) || [];
    rows.push(row); bySource.set(row.sourceRecordId, rows);
  }
  const finishCodes = { normal: 'standard', holo: 'holo', reverse: 'reverse-holo' };
  const records = census.cards.map(card => {
    const rows = (bySource.get(card.id) || []).filter(row => row.languageCode === card.language);
    const ids = [...new Set(rows.map(row=>row.cardIdentityId))];
    const expected = (card.explicitFinishes || []).map(f=>finishCodes[f]);
    const missingExplicitFinishes = expected.filter(f=>!rows.some(row=>row.variantCode===f));
    let status;
    if (card.digital) status = 'outside_physical_scope';
    else if (!card.englishNamed) status = 'language_evidence_required';
    else if (card.held) status = 'intentional_hold';
    else if (!ids.length) status = 'not_mapped';
    else if (missingExplicitFinishes.length) status = 'partially_mapped';
    else if (!expected.length) status = 'mapped_finish_scope_unresolved';
    else status = 'explicit_finishes_mapped';
    return { sourceRecordId: card.id, setId: card.setId, status, mappedIdentityIds: ids, missingExplicitFinishes };
  });
  const counts = Object.fromEntries(['outside_physical_scope','language_evidence_required','intentional_hold','not_mapped','partially_mapped','mapped_finish_scope_unresolved','explicit_finishes_mapped'].map(status=>[status,records.filter(r=>r.status===status).length]));
  const unresolvedRecords = records.filter(r=>['not_mapped','partially_mapped','mapped_finish_scope_unresolved'].includes(r.status));
  return { format:'fatedrop-primary-coverage-ledger-v1', sourceRevision:census.revision, productionWrites:false,
    measuredAgainst:'isolated_rehearsal', sourceRecords:records.length, counts,
    canonicalIdentitiesInMappingExport:new Set(mappings.filter(r=>r.sourceName==='tcgdex').map(r=>r.cardIdentityId)).size,
    completeCanonicalCardinality:null, productionCoverage:null, priceCoverage:null,
    completionStatus:unresolvedRecords.length ? 'coverage_gaps_remain' : 'explicit_scope_accounted_for_not_full_catalogue_proof',
    unresolvedRecords:unresolvedRecords.length,
    sourceMappingsOutsideCensus:[...bySource.keys()].filter(id=>!sourceIds.has(id)), records };
}
