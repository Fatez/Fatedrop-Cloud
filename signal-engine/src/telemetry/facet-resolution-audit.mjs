import { deriveAlertFacets } from "../core/alert-facets.mjs";
import { describeProductIdentity } from "../core/product-identity.mjs";

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

function epoch(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function resolutionState(facets = {}) {
  const languageUnknown = facets.languageGroup === "unknown";
  const setUnknown = !facets.setKey;
  const conflict = String(facets?.source?.language || "").startsWith("language_conflict:");
  if (conflict) return "conflict_quarantined";
  if (languageUnknown && setUnknown) return "both_unresolved";
  if (!languageUnknown && setUnknown) return "language_known_set_unknown";
  if (languageUnknown && !setUnknown) return "set_known_language_unknown";
  return "resolved";
}

function normalizedIdentity(row = {}) {
  const identity = describeProductIdentity({ title: row.title || "" });
  const core = identity.coreSignature || identity.core || String(row.title || "").trim().toLowerCase() || "unknown";
  const productType = identity.productType || "unknown";
  return { key: `${productType}:${core}`, productType };
}

function retailerKey(row = {}) {
  return String(row.retailer_id || row.retailerId || row.retailer_name || row.retailerName || "unknown");
}

function retailerName(row = {}) {
  return String(row.retailer_name || row.retailerName || row.retailer_id || row.retailerId || "Unknown retailer");
}

function needsReviewFor(state, facets) {
  if (state === "conflict_quarantined") return ["language", "language_conflict", ...(!facets.setKey ? ["set"] : [])];
  if (state === "both_unresolved") return ["language", "set"];
  if (state === "language_known_set_unknown") return ["set"];
  if (state === "set_known_language_unknown") return ["language"];
  return [];
}

export function facetResolutionDiagnostics(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  let totalSignalsInWindow = safeRows.length;
  let missingFacetEvidence = 0;
  let unknownLanguage = 0;
  let unknownSet = 0;
  let languageConflicts = 0;
  let bothUnresolved = 0;
  let languageKnownSetUnknown = 0;
  let setKnownLanguageUnknown = 0;
  let fullyResolved = 0;
  const groups = new Map();
  const retailers = new Map();

  for (const row of safeRows) {
    const hintedTotal = Number(row?.facet_audit_total);
    if (Number.isFinite(hintedTotal) && hintedTotal >= 0) totalSignalsInWindow = Math.max(totalSignalsInWindow, hintedTotal);
    if (!latestFacetEvidence(row?.evidence)) missingFacetEvidence += 1;

    const facets = deriveAlertFacets({
      title: row?.title || "",
      evidence: row?.evidence || [],
    });
    const state = resolutionState(facets);
    const languageUnknown = facets.languageGroup === "unknown";
    const setUnknown = !facets.setKey;

    if (languageUnknown) unknownLanguage += 1;
    if (setUnknown) unknownSet += 1;
    if (state === "conflict_quarantined") languageConflicts += 1;
    else if (state === "both_unresolved") bothUnresolved += 1;
    else if (state === "language_known_set_unknown") languageKnownSetUnknown += 1;
    else if (state === "set_known_language_unknown") setKnownLanguageUnknown += 1;
    else fullyResolved += 1;

    if (state === "resolved") continue;

    const identity = normalizedIdentity(row);
    const groupKey = [
      identity.key,
      state,
      facets.languageGroup || "unknown",
      facets.setKey || "unknown",
      facets?.source?.language || "unknown",
      facets?.source?.set || "unknown",
    ].join("|");
    const observedAt = epoch(row?.detected_at ?? row?.detectedAt);
    const existing = groups.get(groupKey) || {
      signalId: row?.id || null,
      state: row?.state || null,
      retailerId: row?.retailer_id || row?.retailerId || null,
      retailerName: retailerName(row),
      title: row?.title || null,
      detectedAt: observedAt,
      normalizedIdentity: identity.key,
      productType: identity.productType,
      resolution: state,
      languageGroup: facets.languageGroup || "unknown",
      setKey: facets.setKey || null,
      setName: facets.setName || null,
      languageSource: facets?.source?.language || "unknown",
      setSource: facets?.source?.set || "unknown",
      needsReview: needsReviewFor(state, facets),
      count: 0,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      retailers: new Map(),
    };
    existing.count += 1;
    if (observedAt != null) {
      existing.firstSeenAt = existing.firstSeenAt == null ? observedAt : Math.min(existing.firstSeenAt, observedAt);
      existing.lastSeenAt = existing.lastSeenAt == null ? observedAt : Math.max(existing.lastSeenAt, observedAt);
      if (existing.detectedAt == null || observedAt > existing.detectedAt) {
        existing.signalId = row?.id || existing.signalId;
        existing.state = row?.state || existing.state;
        existing.retailerId = row?.retailer_id || row?.retailerId || existing.retailerId;
        existing.retailerName = retailerName(row);
        existing.title = row?.title || existing.title;
        existing.detectedAt = observedAt;
      }
    }
    const rKey = retailerKey(row);
    const groupRetailer = existing.retailers.get(rKey) || {
      retailerId: row?.retailer_id || row?.retailerId || null,
      retailerName: retailerName(row),
      count: 0,
    };
    groupRetailer.count += 1;
    existing.retailers.set(rKey, groupRetailer);
    groups.set(groupKey, existing);

    const retailer = retailers.get(rKey) || {
      retailerId: row?.retailer_id || row?.retailerId || null,
      retailerName: retailerName(row),
      unresolvedSignals: 0,
      unresolvedLanguage: 0,
      unresolvedSet: 0,
      bothUnresolved: 0,
      conflictsQuarantined: 0,
    };
    retailer.unresolvedSignals += 1;
    if (languageUnknown) retailer.unresolvedLanguage += 1;
    if (setUnknown) retailer.unresolvedSet += 1;
    if (state === "both_unresolved") retailer.bothUnresolved += 1;
    if (state === "conflict_quarantined") retailer.conflictsQuarantined += 1;
    retailers.set(rKey, retailer);
  }

  const allGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      retailers: [...group.retailers.values()].sort((left, right) => right.count - left.count || left.retailerName.localeCompare(right.retailerName)),
    }))
    .sort((left, right) => right.count - left.count || (right.lastSeenAt || 0) - (left.lastSeenAt || 0) || left.normalizedIdentity.localeCompare(right.normalizedIdentity));
  const reviewQueue = allGroups.slice(0, SAMPLE_LIMIT);
  const retailerDistribution = [...retailers.values()]
    .sort((left, right) => right.unresolvedSignals - left.unresolvedSignals || left.retailerName.localeCompare(right.retailerName));

  return {
    available: true,
    assessedSignals: safeRows.length,
    totalSignalsInWindow,
    missingFacetEvidence,
    unknownLanguage,
    unknownSet,
    languageConflicts,
    totalUnresolvedLanguage: unknownLanguage,
    totalUnresolvedSet: unknownSet,
    bothUnresolved,
    languageKnownSetUnknown,
    setKnownLanguageUnknown,
    conflictsQuarantined: languageConflicts,
    fullyResolved,
    unresolvedGroupCount: allGroups.length,
    reviewQueueSize: reviewQueue.length,
    sampleTruncated: totalSignalsInWindow > safeRows.length || allGroups.length > SAMPLE_LIMIT,
    reviewQueue,
    topUnresolved: reviewQueue,
    retailerDistribution,
  };
}
