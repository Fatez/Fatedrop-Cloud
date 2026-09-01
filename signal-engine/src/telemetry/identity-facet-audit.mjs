import { deriveAlertFacets } from "../core/alert-facets.mjs";
import { describeProductIdentity } from "../core/product-identity.mjs";

const NON_SET_IDENTITIES = new Set(["battle_deck", "special_collection"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowFacets(row) {
  if (row?.facets && typeof row.facets === "object") return row.facets;
  return deriveAlertFacets({
    title: text(row?.title),
    evidence: jsonArray(row?.evidence),
  });
}

function setApplicable(identity) {
  return !NON_SET_IDENTITIES.has(identity?.kind);
}

function issuesFor(facets) {
  const issues = new Set();
  const identity = facets?.canonicalIdentity || { status: "unresolved", kind: "unknown" };
  const languageUnknown = facets?.languageGroup === "unknown";
  const setUnknown = !facets?.setKey && setApplicable(identity);
  const languageConflict = text(facets?.source?.language).startsWith("language_conflict:");

  if (languageUnknown && !languageConflict) issues.add("unknown_language");
  if (setUnknown) issues.add("unknown_set");
  if (languageUnknown && setUnknown && !languageConflict) issues.add("unknown_language_unknown_set");
  if (!languageUnknown && setUnknown) issues.add("known_language_unknown_set");
  if (languageUnknown && facets?.setKey && !languageConflict) issues.add("known_set_unknown_language");
  if (languageConflict) issues.add("language_conflict");
  if (identity.status === "conflict") issues.add("identity_conflict");
  if (identity.status === "broad_family_only") issues.add("suspicious_broad_family");
  if (identity.status === "unresolved") issues.add("unresolved_canonical_identity");
  return [...issues];
}

function groupKey(row, descriptor) {
  const tcg = text(row?.tcg) || "unknown";
  const productId = text(row?.canonical_product_id || row?.product_id || row?.productId);
  if (productId) return `${tcg}:product:${productId}`;
  const canonicalKey = text(row?.canonical_key || row?.canonicalKey);
  if (canonicalKey) return `${tcg}:key:${canonicalKey}`;
  return `${tcg}:candidate:${descriptor.coreSignature || descriptor.core || text(row?.title).toLowerCase() || "unknown"}`;
}

function add(set, value) {
  if (value != null && value !== "") set.add(value);
}

function sortedValues(values, limit = 20) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right))).slice(0, limit);
}

function candidateFrom(group) {
  const facets = group.latestFacets;
  const identity = facets.canonicalIdentity || {};
  const firstObserved = group.firstObserved == null ? null : group.firstObserved;
  const lastObserved = group.lastObserved == null ? null : group.lastObserved;
  return {
    groupKey: group.key,
    tcg: group.tcg,
    canonicalProductId: group.canonicalProductId || null,
    canonicalKey: group.canonicalKey || null,
    titles: sortedValues(group.titles, 5),
    retailers: sortedValues(group.retailers, 20),
    issues: sortedValues(group.issues, 20),
    currentLanguage: facets.languageGroup || "unknown",
    currentSet: facets.setKey ? { key: facets.setKey, name: facets.setName || facets.setKey } : null,
    languageSource: facets.source?.language || "unknown",
    setSource: facets.source?.set || "unknown",
    confidence: {
      language: Number(facets.confidence?.language) || 0,
      set: Number(facets.confidence?.set) || 0,
    },
    canonicalIdentity: {
      status: identity.status || "unresolved",
      kind: identity.kind || "unknown",
      key: identity.key || null,
      name: identity.name || null,
      seriesKey: identity.seriesKey || null,
      seriesName: identity.seriesName || null,
      languageScope: identity.languageScope || "unknown",
      productFamily: identity.productFamily || null,
      source: identity.source || "unknown",
    },
    conflictReason: text(facets.source?.language).startsWith("language_conflict:")
      ? facets.source.language
      : identity.status === "conflict"
        ? identity.source || "canonical_identity_conflict"
        : null,
    candidateAlias: group.candidateAlias || null,
    candidateTokens: group.candidateTokens,
    firstObserved,
    lastObserved,
    signalsAffected: group.signalIds.size,
    offersAffected: group.offerIds.size,
  };
}

function rank(left, right) {
  return right.signalsAffected - left.signalsAffected
    || right.offersAffected - left.offersAffected
    || right.issues.length - left.issues.length
    || String(left.groupKey).localeCompare(String(right.groupKey));
}

export function buildIdentityFacetAudit(rows = [], { limit = 100 } = {}) {
  if (!Array.isArray(rows)) {
    return {
      available: false,
      mutationPolicy: "diagnostic_only_no_identity_promotion",
      countUnit: "canonical_identity_groups",
      totals: null,
      candidateCount: 0,
      candidatesTruncated: false,
      candidates: [],
    };
  }
  const groups = new Map();
  const totals = {
    rowsEvaluated: 0,
    groupsAffected: 0,
    unknownLanguage: 0,
    unknownSet: 0,
    unknownLanguageUnknownSet: 0,
    knownLanguageUnknownSet: 0,
    knownSetUnknownLanguage: 0,
    languageConflicts: 0,
    identityConflicts: 0,
    suspiciousBroadFamily: 0,
    unresolvedCanonicalIdentity: 0,
  };

  for (const row of rows) {
    const title = text(row?.title);
    if (!title) continue;
    totals.rowsEvaluated += 1;
    const descriptor = describeProductIdentity({ title, productType: row?.product_type, tcg: row?.tcg });
    const facets = rowFacets(row);
    const issues = issuesFor(facets);
    if (!issues.length) continue;

    const key = groupKey(row, descriptor);
    const existing = groups.get(key) || {
      key,
      tcg: text(row?.tcg) || "unknown",
      canonicalProductId: text(row?.canonical_product_id || row?.product_id || row?.productId),
      canonicalKey: text(row?.canonical_key || row?.canonicalKey),
      titles: new Set(),
      retailers: new Set(),
      issues: new Set(),
      signalIds: new Set(),
      offerIds: new Set(),
      firstObserved: null,
      lastObserved: null,
      candidateAlias: descriptor.core || null,
      candidateTokens: [...new Set(descriptor.core.split(" ").filter(Boolean))].slice(0, 12),
      latestFacets: facets,
    };
    add(existing.titles, title);
    add(existing.retailers, text(row?.retailer_name || row?.retailerName || row?.retailer_id || row?.retailerId));
    for (const issue of issues) existing.issues.add(issue);
    if (text(row?.record_kind) === "signal" || row?.signal_id || row?.signalId) add(existing.signalIds, text(row?.signal_id || row?.signalId));
    if (text(row?.offer_id || row?.offerId)) add(existing.offerIds, text(row?.offer_id || row?.offerId));
    const observedAt = integer(row?.observed_at || row?.detected_at || row?.last_seen_at || row?.observedAt);
    if (observedAt != null) {
      existing.firstObserved = existing.firstObserved == null ? observedAt : Math.min(existing.firstObserved, observedAt);
      if (existing.lastObserved == null || observedAt >= existing.lastObserved) {
        existing.lastObserved = observedAt;
        existing.latestFacets = facets;
      }
    }
    groups.set(key, existing);
  }

  const candidates = [...groups.values()].map(candidateFrom).sort(rank);
  totals.groupsAffected = candidates.length;
  const countGroups = (issue) => candidates.filter((candidate) => candidate.issues.includes(issue)).length;
  totals.unknownLanguage = countGroups("unknown_language");
  totals.unknownSet = countGroups("unknown_set");
  totals.unknownLanguageUnknownSet = countGroups("unknown_language_unknown_set");
  totals.knownLanguageUnknownSet = countGroups("known_language_unknown_set");
  totals.knownSetUnknownLanguage = countGroups("known_set_unknown_language");
  totals.languageConflicts = countGroups("language_conflict");
  totals.identityConflicts = countGroups("identity_conflict");
  totals.suspiciousBroadFamily = countGroups("suspicious_broad_family");
  totals.unresolvedCanonicalIdentity = countGroups("unresolved_canonical_identity");

  const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
  return {
    available: true,
    mutationPolicy: "diagnostic_only_no_identity_promotion",
    countUnit: "canonical_identity_groups",
    totals,
    candidateCount: candidates.length,
    candidatesTruncated: candidates.length > safeLimit,
    candidates: candidates.slice(0, safeLimit),
  };
}
