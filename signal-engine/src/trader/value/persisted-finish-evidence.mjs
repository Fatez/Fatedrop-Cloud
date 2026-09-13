export async function loadPersistedApprovedFinishEvidence(db, identityIds, snapshotMap) {
  if (!Array.isArray(identityIds) || identityIds.length === 0) return [];
  const { rows } = await db.query(`
    SELECT r.card_identity_id,r.finish,r.language,r.edition,r.observed_finish,r.verdict,r.basis,
           r.review_reference,r.reviewer,s.payload_sha256,s.raw_payload_text,s.source_locator
    FROM fatedrop_variant_evidence_reviews r
    JOIN fatedrop_variant_evidence_snapshots s ON s.id=r.snapshot_id
    WHERE r.approval_state='approved'
      AND r.card_identity_id=ANY($1::text[])
    ORDER BY r.card_identity_id,r.finish,r.reviewed_at,r.id`, [identityIds]);
  const decisions = [];
  for (const row of rows) {
    snapshotMap[row.payload_sha256] = row.raw_payload_text;
    decisions.push({
      cardIdentityId: row.card_identity_id,
      finish: row.finish,
      language: row.language,
      edition: row.edition,
      observedFinish: row.observed_finish,
      verdict: row.verdict,
      basis: row.basis,
      reviewReference: row.review_reference,
      reviewer: row.reviewer,
      sourceLocator: row.source_locator,
      snapshotSha256: row.payload_sha256,
    });
  }
  return decisions;
}

export function applyReviewedEvidenceSupersessions(persisted = [], current = []) {
  const byReference = new Map(persisted.map(decision => [decision.reviewReference, decision]));
  const superseded = new Set();
  for (const decision of current) {
    const refs = Array.isArray(decision.supersedesReviewReferences) ? decision.supersedesReviewReferences : [];
    for (const reference of refs) {
      const prior = byReference.get(reference);
      if (!prior) throw new Error(`Superseded review reference is not an approved persisted decision: ${reference}`);
      if (prior.cardIdentityId !== decision.cardIdentityId
          || prior.finish !== decision.finish
          || prior.language !== decision.language
          || prior.edition !== decision.edition) {
        throw new Error(`Superseded review scope mismatch: ${reference}`);
      }
      if (prior.verdict !== 'does_not_exist' || decision.verdict !== 'exists') {
        throw new Error(`Only does_not_exist -> exists review reversal is permitted: ${reference}`);
      }
      superseded.add(reference);
    }
  }
  return {
    effectivePersisted: persisted.filter(decision => !superseded.has(decision.reviewReference)),
    supersededReviewReferences: [...superseded].sort(),
  };
}

export function mergeReviewedFinishDecisions(persisted = [], current = []) {
  const seen = new Set();
  const merged = [];
  for (const decision of [...persisted, ...current]) {
    const key = [decision.cardIdentityId, decision.finish, decision.language, decision.edition, decision.verdict, decision.snapshotSha256, decision.reviewReference].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(decision);
  }
  merged.sort((a, b) => `${a.cardIdentityId}|${a.finish}|${a.verdict}|${a.snapshotSha256}`.localeCompare(`${b.cardIdentityId}|${b.finish}|${b.verdict}|${b.snapshotSha256}`));
  return merged;
}
