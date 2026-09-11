function intOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function assessCanonicalSetCompleteness({ set, canonicalCards = [], canonicalPrintings = null } = {}) {
  if (!set || typeof set !== 'object') throw new TypeError('set is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (canonicalPrintings != null && !Array.isArray(canonicalPrintings)) throw new TypeError('canonicalPrintings must be an array when provided');

  const setId = text(set.id);
  if (!setId) throw new TypeError('set.id is required');

  const expectedTotal = intOrNull(set.total) ?? intOrNull(set.printedTotal);
  const verifiedPrintingIds = new Set(
    (canonicalPrintings ?? canonicalCards)
      .filter((row) => row && row.verificationStatus === 'verified')
      .filter((row) => text(row.setId) === setId)
      .map((row) => text(canonicalPrintings == null ? row.printingId : (row.printingId ?? row.id)))
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
