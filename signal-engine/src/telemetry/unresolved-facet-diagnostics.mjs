import { deriveAlertFacets } from "../core/alert-facets.mjs";
import { describeProductIdentity } from "../core/product-identity.mjs";

const DEFAULT_TOP_LIMIT = 25;

function epoch(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function facetResolutionState(facets = {}) {
  const languageUnknown = facets.languageGroup === "unknown";
  const setUnknown = !facets.setKey;
  const conflict = String(facets?.source?.language || "").startsWith("language_conflict:");
  if (conflict) return "conflict_quarantined";
  if (languageUnknown && setUnknown) return "both_unresolved";
  if (!languageUnknown && setUnknown) return "language_known_set_unknown";
  if (languageUnknown && !setUnknown) return "set_known_language_unknown";
  return "resolved";
}

function identityKey(row, facets, state) {
  const identity = describeProductIdentity({ title: row?.title || "" });
  const core = identity.coreSignature || identity.core || String(row?.title || "").trim().toLowerCase() || "unknown";
  const type = identity.productType || "unknown";
  return {
    key: `${type}|${core}|${state}|${facets?.languageGroup || "unknown"}|${facets?.setKey || "unknown"}`,
    normalizedIdentity: `${type}:${core}`,
    productType: type,
  };
}

function retailerKey(row = {}) {
  return String(row.retailer_id || row.retailerId || row.retailer_name || row.retailerName || "unknown");
}

function retailerName(row = {}) {
  return String(row.retailer_name || row.retailerName || row.retailer_id || row.retailerId || "Unknown retailer");
}

export function buildUnresolvedFacetDiagnostics(rows, { topLimit = DEFAULT_TOP_LIMIT } = {}) {
  if (!Array.isArray(rows)) {
    return {
      available: false,
      reason: "facet_audit_unavailable",
      sampleSize: 0,
      sampleTruncated: false,
      totalSignalsInWindow: 0,
      counts: {
        totalUnresolvedLanguage: 0,
        totalUnresolvedSet: 0,
        bothUnresolved: 0,
        languageKnownSetUnknown: 0,
        setKnownLanguageUnknown: 0,
        conflictsQuarantined: 0,
        fullyResolved: 0,
      },
      topUnresolved: [],
      retailerDistribution: [],
    };
  }

  const safeTopLimit = Math.max(1, Math.min(100, Math.trunc(Number(topLimit) || DEFAULT_TOP_LIMIT)));
  const counts = {
    totalUnresolvedLanguage: 0,
    totalUnresolvedSet: 0,
    bothUnresolved: 0,
    languageKnownSetUnknown: 0,
    setKnownLanguageUnknown: 0,
    conflictsQuarantined: 0,
    fullyResolved: 0,
  };
  const groups = new Map();
  const retailers = new Map();
  let totalSignalsInWindow = rows.length;

  for (const row of rows) {
    const hintedTotal = Number(row?.facet_audit_total);
    if (Number.isFinite(hintedTotal) && hintedTotal >= 0) totalSignalsInWindow = Math.max(totalSignalsInWindow, hintedTotal);

    const facets = deriveAlertFacets({
      title: row?.title || "",
      evidence: row?.evidence || [],
    });
    const state = facetResolutionState(facets);
    const languageUnknown = facets.languageGroup === "unknown";
    const setUnknown = !facets.setKey;

    if (languageUnknown) counts.totalUnresolvedLanguage += 1;
    if (setUnknown) counts.totalUnresolvedSet += 1;
    if (state === "both_unresolved") counts.bothUnresolved += 1;
    else if (state === "language_known_set_unknown") counts.languageKnownSetUnknown += 1;
    else if (state === "set_known_language_unknown") counts.setKnownLanguageUnknown += 1;
    else if (state === "conflict_quarantined") counts.conflictsQuarantined += 1;
    else counts.fullyResolved += 1;

    if (state === "resolved") continue;

    const observedAt = epoch(row?.detected_at ?? row?.detectedAt);
    const identity = identityKey(row, facets, state);
    const existing = groups.get(identity.key) || {
      identityKey: identity.normalizedIdentity,
      representativeTitle: String(row?.title || "Unknown product"),
      productType: identity.productType,
      resolution: state,
      languageGroup: facets.languageGroup,
      setKey: facets.setKey || null,
      setName: facets.setName || null,
      languageSource: facets?.source?.language || "unknown",
      setSource: facets?.source?.set || "unknown",
      count: 0,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      retailers: new Map(),
    };
    existing.count += 1;
    if (observedAt != null) {
      existing.firstSeenAt = existing.firstSeenAt == null ? observedAt : Math.min(existing.firstSeenAt, observedAt);
      existing.lastSeenAt = existing.lastSeenAt == null ? observedAt : Math.max(existing.lastSeenAt, observedAt);
    }
    const rKey = retailerKey(row);
    existing.retailers.set(rKey, {
      retailerId: row?.retailer_id || row?.retailerId || null,
      retailerName: retailerName(row),
      count: (existing.retailers.get(rKey)?.count || 0) + 1,
    });
    groups.set(identity.key, existing);

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

  const topUnresolved = [...groups.values()]
    .map((group) => ({
      ...group,
      retailers: [...group.retailers.values()].sort((left, right) => right.count - left.count || left.retailerName.localeCompare(right.retailerName)),
    }))
    .sort((left, right) => right.count - left.count || (right.lastSeenAt || 0) - (left.lastSeenAt || 0) || left.identityKey.localeCompare(right.identityKey))
    .slice(0, safeTopLimit);

  const retailerDistribution = [...retailers.values()]
    .sort((left, right) => right.unresolvedSignals - left.unresolvedSignals || left.retailerName.localeCompare(right.retailerName));

  return {
    available: true,
    sampleSize: rows.length,
    sampleTruncated: totalSignalsInWindow > rows.length,
    totalSignalsInWindow,
    counts,
    topUnresolved,
    retailerDistribution,
  };
}
