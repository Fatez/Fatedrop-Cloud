function intOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function assessCanonicalSetCompleteness({ set, canonicalCards } = {}) {
  if (!set || typeof set !== 'object') throw new TypeError('set is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');

  const setId = text(set.id);
  if (!setId) throw new TypeError('set.id is required');

  const expectedTotal = intOrNull(set.total) ?? intOrNull(set.printedTotal);
  const verifiedPrintingIds = new Set(
    canonicalCards
      .filter((card) => card && card.verificationStatus === 'verified')
      .filter((card) => text(card.setId) === setId)
      .map((card) => text(card.printingId))
      .filter(Boolean),
  );
  const observedTotal = verifiedPrintingIds.size;

  if (expectedTotal == null || expectedTotal === 0) {
    return Object.freeze({
      status: 'unknown',
      reason: 'declared_set_total_unavailable',
      setId,
      expectedTotal: expectedTotal || null,
      observedTotal,
      missingCanonicalCount: null,
    });
  }

  if (observedTotal < expectedTotal) {
    return Object.freeze({
      status: 'incomplete',
      reason: 'canonical_checklist_incomplete',
      setId,
      expectedTotal,
      observedTotal,
      missingCanonicalCount: expectedTotal - observedTotal,
    });
  }

  if (observedTotal > expectedTotal) {
    return Object.freeze({
      status: 'conflict',
      reason: 'canonical_checklist_exceeds_declared_total',
      setId,
      expectedTotal,
      observedTotal,
      missingCanonicalCount: 0,
    });
  }

  return Object.freeze({
    status: 'complete',
    reason: null,
    setId,
    expectedTotal,
    observedTotal,
    missingCanonicalCount: 0,
  });
}
