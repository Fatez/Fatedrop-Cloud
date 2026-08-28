import { createHash } from "node:crypto";

const LIVE_STOCK = new Set(["in_stock", "low_stock", "preorder"]);
const PRODUCT_TYPE_POINTS = Object.freeze({
  booster_box: 20,
  elite_trainer_box: 20,
  booster_bundle: 16,
  collection_box: 14,
  tin: 10,
  booster_pack: 8,
});

function text(value) { return String(value ?? "").trim(); }
function lower(value) { return text(value).toLowerCase(); }
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function evidenceFor(row = {}) {
  return row?.evidence_json && typeof row.evidence_json === "object"
    ? row.evidence_json
    : row?.evidence && typeof row.evidence === "object"
      ? row.evidence
      : {};
}
function normalizedTitle(value = "") {
  return lower(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyRrpGap(reason = "") {
  const value = lower(reason) || "verified_rrp_unavailable";
  if (/conflict/.test(value)) {
    return {
      classification: "authority_conflict",
      nextAction: "hold_fail_closed_until_authority_conflict_is_resolved",
      actionability: "manual_authority_review",
    };
  }
  if (value === "no_authoritative_candidate" || value === "registry_unavailable") {
    return {
      classification: "authority_gap",
      nextAction: "await_or_refresh_authoritative_rrp_source",
      actionability: "authority_refresh",
    };
  }
  if (value === "no_exact_identity_match" || value === "identity_bucket_unavailable" || value === "reference_identity_too_weak") {
    return {
      classification: "identity_gap",
      nextAction: "review_verified_identity_or_safe_alias_evidence",
      actionability: "identity_review",
    };
  }
  if (value === "no_verified_pack_reference") {
    return {
      classification: "component_authority_gap",
      nextAction: "await_verified_equivalent_pack_reference",
      actionability: "component_authority_refresh",
    };
  }
  return {
    classification: "unresolved_reference",
    nextAction: "retry_after_authority_or_identity_evidence_changes",
    actionability: "evidence_watch",
  };
}

export function rrpGapGroupKey(row = {}) {
  const evidence = evidenceFor(row);
  const productId = text(row.product_id || row.productId);
  if (productId) return `product:${productId}`;
  const alias = text(evidence.alias_signature);
  if (alias) return `alias:${alias}`;
  return `title:${lower(row.tcg || "pokemon")}|${lower(row.product_type || row.productType)}|${normalizedTitle(row.observed_title || row.observedTitle)}`;
}

export function rrpObservationFingerprint(row = {}) {
  const evidence = evidenceFor(row);
  const facts = [
    text(row.product_id || row.productId),
    text(row.offer_id || row.offerId),
    lower(row.failure_reason || row.failureReason),
    lower(evidence.stock_status || evidence.stockStatus),
    text(evidence.price_pence ?? evidence.pricePence),
    text(evidence.postage_pence ?? evidence.postagePence),
    text(evidence.gtin),
    text(evidence.retailer_sku || evidence.retailerSku),
  ].join("|");
  return `rrpobs:${createHash("sha256").update(facts).digest("hex").slice(0, 16)}`;
}

export function currentRrpObservationFingerprint(row = {}) {
  const evidence = evidenceFor(row);
  return text(evidence.current_observation_fingerprint) || rrpObservationFingerprint(row);
}

export function rrpGapPriority(row = {}, {
  now = Math.floor(Date.now() / 1000),
  crossRetailerCount = 1,
} = {}) {
  const evidence = evidenceFor(row);
  const occurrenceCount = Math.max(1, number(row.occurrence_count ?? row.occurrenceCount) || 1);
  const productType = lower(row.product_type || row.productType);
  const stockStatus = lower(evidence.stock_status || evidence.stockStatus);
  const lastSeenAt = number(row.last_seen_at ?? row.lastSeenAt) || number(evidence.last_observation_at) || 0;
  const ageSeconds = lastSeenAt > 0 ? Math.max(0, now - lastSeenAt) : Number.POSITIVE_INFINITY;
  const gap = classifyRrpGap(row.failure_reason || row.failureReason);

  let score = Math.min(30, occurrenceCount * 3);
  score += PRODUCT_TYPE_POINTS[productType] || 0;
  if (LIVE_STOCK.has(stockStatus) || evidence.live_offer === true) score += 20;
  if (text(evidence.gtin) || text(evidence.retailer_sku)) score += 10;
  score += Math.min(10, Math.max(0, Number(crossRetailerCount) - 1) * 5);
  if (ageSeconds <= 60 * 60) score += 10;
  else if (ageSeconds <= 24 * 60 * 60) score += 7;
  else if (ageSeconds <= 7 * 24 * 60 * 60) score += 3;

  if (gap.classification === "identity_gap") score += 8;
  else if (gap.classification === "authority_gap" || gap.classification === "component_authority_gap") score += 5;
  else if (gap.classification === "authority_conflict") score += 2;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function rankRrpGapRows(rows = [], { now = Math.floor(Date.now() / 1000) } = {}) {
  const retailerSets = new Map();
  for (const row of rows || []) {
    const key = rrpGapGroupKey(row);
    const set = retailerSets.get(key) || new Set();
    set.add(text(row.retailer_id || row.retailerId) || "unknown");
    retailerSets.set(key, set);
  }

  return (rows || []).map((row) => {
    const key = rrpGapGroupKey(row);
    const crossRetailerCount = retailerSets.get(key)?.size || 1;
    const gap = classifyRrpGap(row.failure_reason || row.failureReason);
    const evidence = evidenceFor(row);
    return {
      row,
      intelligence: {
        ...gap,
        priority: rrpGapPriority(row, { now, crossRetailerCount }),
        groupKey: key,
        crossRetailerCount,
        liveOffer: LIVE_STOCK.has(lower(evidence.stock_status || evidence.stockStatus)) || evidence.live_offer === true,
        hasIdentifierEvidence: Boolean(text(evidence.gtin) || text(evidence.retailer_sku)),
        currentObservationFingerprint: currentRrpObservationFingerprint(row),
      },
    };
  }).sort((left, right) => {
    if (right.intelligence.priority !== left.intelligence.priority) return right.intelligence.priority - left.intelligence.priority;
    const rightOccurrences = number(right.row.occurrence_count ?? right.row.occurrenceCount) || 0;
    const leftOccurrences = number(left.row.occurrence_count ?? left.row.occurrenceCount) || 0;
    if (rightOccurrences !== leftOccurrences) return rightOccurrences - leftOccurrences;
    return (number(right.row.last_seen_at ?? right.row.lastSeenAt) || 0) - (number(left.row.last_seen_at ?? left.row.lastSeenAt) || 0);
  });
}

export function buildRrpGapSnapshot(rows = [], {
  now = Math.floor(Date.now() / 1000),
  limit = 10,
} = {}) {
  const ranked = rankRrpGapRows(rows, { now });
  const byClass = {};
  const byProductType = {};
  const byRetailer = {};
  let liveOpen = 0;
  let highPriorityOpen = 0;

  for (const item of ranked) {
    const row = item.row;
    const intel = item.intelligence;
    byClass[intel.classification] = (byClass[intel.classification] || 0) + 1;
    const productType = text(row.product_type || row.productType) || "unknown";
    byProductType[productType] = (byProductType[productType] || 0) + 1;
    const retailerId = text(row.retailer_id || row.retailerId) || "unknown";
    byRetailer[retailerId] = (byRetailer[retailerId] || 0) + 1;
    if (intel.liveOffer) liveOpen += 1;
    if (intel.priority >= 75) highPriorityOpen += 1;
  }

  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  return {
    generatedAt: now,
    openRows: ranked.length,
    liveOpen,
    highPriorityOpen,
    byClass,
    byProductType,
    byRetailer,
    topGaps: ranked.slice(0, safeLimit).map(({ row, intelligence }) => ({
      id: row.id || null,
      retailerId: row.retailer_id || row.retailerId || null,
      productId: row.product_id || row.productId || null,
      title: row.observed_title || row.observedTitle || null,
      productType: row.product_type || row.productType || null,
      failureReason: row.failure_reason || row.failureReason || null,
      occurrenceCount: number(row.occurrence_count ?? row.occurrenceCount) || 0,
      lastSeenAt: number(row.last_seen_at ?? row.lastSeenAt),
      ...intelligence,
    })),
  };
}
