function validTimestamp(value) {
  return Number.isFinite(value) && value > 0;
}

export function promoteMatchedCardEvidence(match, { verifiedAt = Date.now() } = {}) {
  if (!match || match.status !== 'matched') {
    return Object.freeze({ status: 'rejected', reason: 'matched_card_evidence_required', identities: Object.freeze([]) });
  }
  if (!validTimestamp(verifiedAt)) {
    throw new TypeError('verifiedAt must be a positive timestamp');
  }
  if (!Array.isArray(match.candidates) || match.candidates.length === 0) {
    return Object.freeze({ status: 'rejected', reason: 'no_card_candidates', identities: Object.freeze([]) });
  }
  if (!match.corroboration?.sourceName || !match.corroboration?.sourceRecordId) {
    return Object.freeze({ status: 'rejected', reason: 'independent_corroboration_required', identities: Object.freeze([]) });
  }

  const seen = new Set();
  const promoted = [];
  for (const candidate of match.candidates) {
    if (!candidate?.fateCardId || !candidate?.canonicalKey) {
      return Object.freeze({ status: 'rejected', reason: 'invalid_card_candidate', identities: Object.freeze([]) });
    }
    if (candidate.verificationStatus !== 'staged') {
      return Object.freeze({ status: 'rejected', reason: 'candidate_not_staged', identities: Object.freeze([]) });
    }
    if (candidate.sourceName === match.corroboration.sourceName) {
      return Object.freeze({ status: 'rejected', reason: 'independent_sources_required', identities: Object.freeze([]) });
    }
    if (seen.has(candidate.fateCardId)) {
      return Object.freeze({ status: 'rejected', reason: 'duplicate_canonical_identity', identities: Object.freeze([]) });
    }
    seen.add(candidate.fateCardId);
    promoted.push(Object.freeze({
      ...candidate,
      verificationStatus: 'verified',
      verifiedAt,
      verificationBasis: Object.freeze({
        baseIdentitySources: Object.freeze([
          Object.freeze({ sourceName: candidate.sourceName, sourceRecordId: candidate.sourceRecordId }),
          Object.freeze({ sourceName: match.corroboration.sourceName, sourceRecordId: match.corroboration.sourceRecordId }),
        ]),
        variantEvidenceSource: candidate.sourceName,
        variantEvidenceExplicit: true,
      }),
    }));
  }

  return Object.freeze({ status: 'verified', identities: Object.freeze(promoted) });
}
