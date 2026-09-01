const AUDIT_FACET_VERSION = 2;
const SAMPLE_LIMIT = 50;

function evidenceEntries(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function latestFacetEvidence(value) {
  return evidenceEntries(value)
    .filter((entry) => entry?.kind === "alert_facets" && entry?.version === AUDIT_FACET_VERSION)
    .sort((left, right) => Number(right?.observedAt || 0) - Number(left?.observedAt || 0))[0] || null;
}

function sampleKey(row, facet) {
  return [
    String(row?.title || "").trim().toLowerCase(),
    facet?.languageGroup || "unknown",
    facet?.setKey || "unknown",
    facet?.languageSource || "unknown",
    facet?.setSource || "unknown",
  ].join("|");
}

export function facetResolutionDiagnostics(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  let assessedSignals = 0;
  let missingFacetEvidence = 0;
  let unknownLanguage = 0;
  let unknownSet = 0;
  let languageConflicts = 0;
  const samples = [];
  const seen = new Set();

  for (const row of safeRows) {
    const facet = latestFacetEvidence(row?.evidence);
    if (!facet) {
      missingFacetEvidence += 1;
      continue;
    }
    assessedSignals += 1;
    const languageUnknown = facet.languageGroup === "unknown";
    const setUnknown = !facet.setKey;
    const conflict = String(facet.languageSource || "").startsWith("language_conflict:");
    if (languageUnknown) unknownLanguage += 1;
    if (setUnknown) unknownSet += 1;
    if (conflict) languageConflicts += 1;
    if (!languageUnknown && !setUnknown && !conflict) continue;

    const key = sampleKey(row, facet);
    if (seen.has(key) || samples.length >= SAMPLE_LIMIT) continue;
    seen.add(key);
    samples.push({
      signalId: row?.id || null,
      state: row?.state || null,
      retailerId: row?.retailer_id || null,
      retailerName: row?.retailer_name || null,
      title: row?.title || null,
      detectedAt: Number(row?.detected_at) || null,
      languageGroup: facet.languageGroup || "unknown",
      setKey: facet.setKey || null,
      setName: facet.setName || null,
      languageSource: facet.languageSource || "unknown",
      setSource: facet.setSource || "unknown",
      needsReview: [
        ...(languageUnknown ? ["language"] : []),
        ...(setUnknown ? ["set"] : []),
        ...(conflict ? ["language_conflict"] : []),
      ],
    });
  }

  return {
    available: true,
    assessedSignals,
    missingFacetEvidence,
    unknownLanguage,
    unknownSet,
    languageConflicts,
    reviewQueueSize: samples.length,
    sampleTruncated: samples.length >= SAMPLE_LIMIT,
    reviewQueue: samples,
  };
}
