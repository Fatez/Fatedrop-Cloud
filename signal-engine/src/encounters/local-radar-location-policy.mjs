const RETAILER_LOCATION_POLICY = Object.freeze({
  "aldi-uk": { retailerCategory: "supermarket", tcgSellerStatus: "likely", tcgSellerConfidence: 55 },
  "argos-uk": { retailerCategory: "general_retail", tcgSellerStatus: "likely", tcgSellerConfidence: 65 },
  "asda-uk": { retailerCategory: "supermarket", tcgSellerStatus: "likely", tcgSellerConfidence: 65 },
  "bm-stores-uk": { retailerCategory: "value_retail", tcgSellerStatus: "likely", tcgSellerConfidence: 55 },
  "costco-uk": { retailerCategory: "warehouse_club", tcgSellerStatus: "likely", tcgSellerConfidence: 70 },
  "entertainer-uk": { retailerCategory: "toy_store", tcgSellerStatus: "likely", tcgSellerConfidence: 85 },
  "forbidden-planet-uk": { retailerCategory: "specialist_tcg", tcgSellerStatus: "verified", tcgSellerConfidence: 90 },
  "game-uk": { retailerCategory: "entertainment", tcgSellerStatus: "likely", tcgSellerConfidence: 80 },
  "hobbycraft-uk": { retailerCategory: "hobby_store", tcgSellerStatus: "likely", tcgSellerConfidence: 75 },
  "hmv-uk": { retailerCategory: "entertainment", tcgSellerStatus: "likely", tcgSellerConfidence: 75 },
  "jet-cards": { retailerCategory: "specialist_tcg", tcgSellerStatus: "verified", tcgSellerConfidence: 100 },
  "menkind-uk": { retailerCategory: "general_retail", tcgSellerStatus: "likely", tcgSellerConfidence: 70 },
  "morrisons-uk": { retailerCategory: "supermarket", tcgSellerStatus: "likely", tcgSellerConfidence: 55 },
  "ryman-uk": { retailerCategory: "book_stationery", tcgSellerStatus: "likely", tcgSellerConfidence: 75 },
  "sainsburys-uk": { retailerCategory: "supermarket", tcgSellerStatus: "likely", tcgSellerConfidence: 60 },
  "smyths-uk": { retailerCategory: "toy_store", tcgSellerStatus: "likely", tcgSellerConfidence: 85 },
  "tesco-uk": { retailerCategory: "supermarket", tcgSellerStatus: "likely", tcgSellerConfidence: 60 },
  "the-card-vault-uk": { retailerCategory: "specialist_tcg", tcgSellerStatus: "verified", tcgSellerConfidence: 100 },
  "the-works-uk": { retailerCategory: "book_stationery", tcgSellerStatus: "likely", tcgSellerConfidence: 70 },
  "tgjones-uk": { retailerCategory: "book_stationery", tcgSellerStatus: "likely", tcgSellerConfidence: 75 },
  "total-cards": { retailerCategory: "specialist_tcg", tcgSellerStatus: "verified", tcgSellerConfidence: 100 },
  "travelling-man-uk": { retailerCategory: "specialist_tcg", tcgSellerStatus: "verified", tcgSellerConfidence: 100 },
  "waterstones-uk": { retailerCategory: "book_stationery", tcgSellerStatus: "likely", tcgSellerConfidence: 75 },
});

const RETAILER_CATEGORIES = new Set([
  "book_stationery",
  "entertainment",
  "general_retail",
  "hobby_store",
  "specialist_tcg",
  "supermarket",
  "toy_store",
  "value_retail",
  "warehouse_club",
  "other",
]);
const SELLER_STATES = new Set(["verified", "likely", "candidate", "excluded", "conflicted"]);
const OPERATIONAL_STATES = new Set(["open", "opening_soon", "closed", "unknown"]);
const IDENTITY_STATES = new Set(["canonical", "provisional", "conflicted"]);
const VISIBILITY_CLASSES = new Set(["eligible", "directory-only", "excluded", "unresolved"]);
const STRONG_BRANCH_TCG_SOURCES = new Set([
  "official_retailer_page",
  "retailer_staff_report",
  "retailer_submission",
  "authorised_feed",
  "operator_manual",
]);
const STRONG_CANONICAL_VERIFICATIONS = new Set([
  "official_retailer_branch",
  "curated_branch",
  "operator_verified",
  "independently_reconciled",
  "canonical_reconciled",
]);
const STRONG_CANONICAL_SOURCE_TYPES = new Set([
  "official_retailer_branch_page",
  "official_branch_page",
  "official_retailer_directory",
  "curated_branch_seed",
  "operator_manual",
  "independent_branch_reconciliation",
]);

const SERVICE_PATTERNS = Object.freeze([
  ["pharmacy", /\b(pharmacy|chemist)\b/i],
  ["petrol_station", /\b(?:petrol|fuel)(?:\s+(?:station|forecourt|express))?\b|\bfilling\s+station\b|\bforecourt\b|\besso\b/i],
  ["locker", /\b(parcel\s+locker|locker|inpost|amazon\s+locker)\b/i],
  ["service_counter", /\b(customer\s+service|service\s+counter|click\s*(?:&|and)\s*collect\s+counter|collection\s+counter)\b/i],
]);

function text(value) {
  const result = String(value ?? "").trim().toLowerCase();
  return result || null;
}

function enumValue(value, allowed, fallback) {
  const normalized = text(value);
  return normalized && allowed.has(normalized) ? normalized : fallback;
}

function confidence(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function epochSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed > 10_000_000_000 ? parsed / 1000 : parsed);
}

function timestampMs(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function qualityHaystack(record = {}) {
  const openingDetails = record.openingDetails ?? record.opening_details_json ?? {};
  return [
    record.name,
    record.address,
    record.storeFormat ?? record.store_format,
    openingDetails?.storeFormat,
    openingDetails?.locationType,
    openingDetails?.category,
  ].filter(Boolean).join(" ");
}

function hasStrongCanonicalBranchEvidence(record = {}, openingDetails = {}) {
  const verification = text(record.verification ?? record.verificationStatus ?? record.verification_status);
  const sourceType = text(record.sourceType ?? record.source_type ?? openingDetails?.sourceType);
  const provider = text(record.provider);
  const explicitReconciliation = record.canonicalReconciled === true
    || record.canonical_reconciled === true
    || openingDetails?.canonicalReconciled === true
    || openingDetails?.identityReconciled === true;
  const retailerOwnedProvider = provider === "fatedrop_curated_branch"
    || Boolean(provider && (provider.includes("official_directory") || provider.includes("official_stockist")));
  return STRONG_CANONICAL_VERIFICATIONS.has(verification)
    || STRONG_CANONICAL_SOURCE_TYPES.has(sourceType)
    || retailerOwnedProvider
    || explicitReconciliation;
}

export function locationServiceKind(record = {}) {
  const haystack = qualityHaystack(record);
  for (const [kind, pattern] of SERVICE_PATTERNS) {
    if (pattern.test(haystack)) return kind;
  }
  return null;
}

export function locationPolicyForRetailer(retailerId) {
  return RETAILER_LOCATION_POLICY[String(retailerId || "").trim()] || {
    retailerCategory: "other",
    tcgSellerStatus: "candidate",
    tcgSellerConfidence: 0,
  };
}

export function normalizeLocationPolicy(record = {}) {
  const retailerId = String(record.retailerId ?? record.retailer_id ?? "").trim();
  const fallback = locationPolicyForRetailer(retailerId);
  const openingDetails = record.openingDetails ?? record.opening_details_json ?? {};
  const conflictStatus = text(record.identityConflictStatus ?? record.identity_conflict_status)
    || (openingDetails?.identityConflict === true ? "conflicted" : null);
  const verification = text(record.verification ?? record.verificationStatus ?? record.verification_status);
  const discoveryOnly = verification === "provider_discovered" && !hasStrongCanonicalBranchEvidence(record, openingDetails);
  const identityStatus = conflictStatus === "conflicted"
    ? "conflicted"
    : discoveryOnly
      ? "provisional"
      : enumValue(record.identityStatus ?? record.identity_status, IDENTITY_STATES, "canonical");
  const retailerCategory = enumValue(
    record.retailerCategory ?? record.retailer_category,
    RETAILER_CATEGORIES,
    fallback.retailerCategory,
  );
  const rawStoreFormat = String(record.storeFormat ?? record.store_format ?? openingDetails?.storeFormat ?? "unknown").trim() || "unknown";
  const knownCanonicalRetailer = Object.hasOwn(RETAILER_LOCATION_POLICY, retailerId);
  const rawSellerStatus = enumValue(record.tcgSellerStatus ?? record.tcg_seller_status, SELLER_STATES, fallback.tcgSellerStatus);
  const legacyCanonicalEnrichment = identityStatus === "canonical"
    && knownCanonicalRetailer
    && text(rawStoreFormat) === "unknown";
  const sellerStatus = identityStatus === "conflicted"
    ? "conflicted"
    : legacyCanonicalEnrichment && rawSellerStatus === "candidate"
      ? fallback.tcgSellerStatus
      : rawSellerStatus;
  const derivedStoreFormat = identityStatus === "canonical"
    && text(rawStoreFormat) === "unknown"
    && knownCanonicalRetailer
    && fallback.retailerCategory !== "other"
      ? fallback.retailerCategory
      : rawStoreFormat;
  const retailerGroup = text(record.retailerGroup ?? record.retailer_group)
    || (retailerCategory === "supermarket" || retailerCategory === "warehouse_club"
      ? "supermarkets"
      : retailerCategory === "specialist_tcg"
        ? "independents"
        : retailerCategory === "other"
          ? "unclassified"
          : "large_retailers");
  return {
    retailerCategory,
    retailerGroup: ["supermarkets", "large_retailers", "independents", "unclassified"].includes(retailerGroup) ? retailerGroup : "unclassified",
    storeFormat: derivedStoreFormat,
    storeFormatSource: derivedStoreFormat !== rawStoreFormat ? "canonical_retailer_category" : (text(rawStoreFormat) === "unknown" ? "unknown" : "source"),
    operationalStatus: enumValue(
      record.operationalStatus ?? record.operational_status,
      OPERATIONAL_STATES,
      "unknown",
    ),
    tcgSellerStatus: sellerStatus,
    tcgSellerStatusSource: sellerStatus !== rawSellerStatus ? "canonical_retailer_policy" : "source",
    tcgSellerConfidence: sellerStatus === "conflicted"
      ? 0
      : confidence(record.tcgSellerConfidence ?? record.tcg_seller_confidence, fallback.tcgSellerConfidence),
    identityStatus,
    lastVerifiedAt: epochSeconds(record.lastVerifiedAt ?? record.last_verified_at),
    evidenceSourceCount: Math.max(0, Number(record.evidenceSourceCount ?? record.evidence_source_count) || 0),
  };
}

export function classifyLocationQuality(location = {}) {
  const explicit = enumValue(
    location.visibilityClass ?? location.visibility_class ?? location.openingDetails?.visibilityClass ?? location.opening_details_json?.visibilityClass,
    VISIBILITY_CLASSES,
    null,
  );
  const explicitReason = text(
    location.visibilityReason ?? location.visibility_reason ?? location.openingDetails?.visibilityReason ?? location.opening_details_json?.visibilityReason,
  );
  if (explicit) return { visibilityClass: explicit, reason: explicitReason || "explicit_classification", serviceKind: locationServiceKind(location) };

  const policy = normalizeLocationPolicy(location);
  const serviceKind = locationServiceKind(location);
  if (policy.operationalStatus === "closed") return { visibilityClass: "excluded", reason: "closed", serviceKind };
  if (policy.identityStatus === "conflicted" || policy.tcgSellerStatus === "conflicted") {
    return { visibilityClass: "unresolved", reason: "identity_conflict", serviceKind };
  }
  if (policy.tcgSellerStatus === "excluded") return { visibilityClass: "excluded", reason: "seller_excluded", serviceKind };
  if (serviceKind) return { visibilityClass: "excluded", reason: serviceKind, serviceKind };
  if (policy.identityStatus === "provisional") return { visibilityClass: "unresolved", reason: "provisional_identity", serviceKind: null };
  if (text(policy.storeFormat) === "unknown") return { visibilityClass: "directory-only", reason: "store_format_unknown", serviceKind: null };
  if (policy.tcgSellerStatus === "candidate") return { visibilityClass: "directory-only", reason: "tcg_relevance_unverified", serviceKind: null };
  return { visibilityClass: "eligible", reason: policy.tcgSellerStatus === "verified" ? "branch_tcg_verified" : "canonical_retail_branch", serviceKind: null };
}

export function isRadarEligibleLocation(location = {}) {
  return classifyLocationQuality(location).visibilityClass === "eligible";
}

export function hasExplicitTcgRelevance(location = {}, evidence = {}) {
  const policy = normalizeLocationPolicy(location);
  const sourceType = text(evidence.sourceType ?? evidence.source_type);
  const branchEvidence = evidence.explicitTcgRelevance === true
    && evidence.exactBranch === true
    && Boolean(sourceType && STRONG_BRANCH_TCG_SOURCES.has(sourceType));
  return policy.tcgSellerStatus === "verified" || branchEvidence;
}

export function isEchoEvidenceFresh(evidence = {}, now = Date.now()) {
  const expiresAt = timestampMs(evidence.expiresAt ?? evidence.expires_at ?? evidence.validUntil ?? evidence.valid_until);
  return Number.isFinite(expiresAt) && expiresAt > Number(now);
}

export function isEchoEligibleLocation(location = {}, evidence = {}, now = Date.now()) {
  const sourceType = text(evidence.sourceType ?? evidence.source_type);
  const authoritative = Boolean(sourceType && STRONG_BRANCH_TCG_SOURCES.has(sourceType));
  const productRelevant = evidence.productRelevant === true
    || Boolean(text(evidence.productIdentityId ?? evidence.product_identity_id ?? evidence.rawProductTitle ?? evidence.raw_product_title));
  return isRadarEligibleLocation(location)
    && evidence.exactBranch === true
    && evidence.chainWide !== true
    && authoritative
    && hasExplicitTcgRelevance(location, evidence)
    && productRelevant
    && isEchoEvidenceFresh(evidence, now);
}

export function publicLocationEvidence(location = {}) {
  const policy = normalizeLocationPolicy(location);
  const quality = classifyLocationQuality(location);
  return {
    branchIdentity: policy.identityStatus,
    pokemonSeller: policy.tcgSellerStatus,
    confidence: policy.tcgSellerConfidence,
    sourceCount: policy.evidenceSourceCount,
    lastVerifiedAt: policy.lastVerifiedAt,
    visibilityClass: quality.visibilityClass,
    visibilityReason: quality.reason,
    caveat: policy.tcgSellerStatus === "verified"
      ? "Evidence supports Pokémon TCG sales at this branch; exact stock is still unknown until Echo · In-store confirmed."
      : policy.tcgSellerStatus === "likely"
        ? "This is a canonical retail branch of a retailer associated with Pokémon TCG sales; branch TCG participation is not verified until explicit evidence exists."
        : "Branch location only; Pokémon TCG sales at this branch are not verified.",
  };
}

export const LOCATION_POLICY_ENUMS = Object.freeze({
  retailerCategories: [...RETAILER_CATEGORIES],
  retailerGroups: ["supermarkets", "large_retailers", "independents", "unclassified"],
  sellerStates: [...SELLER_STATES],
  operationalStates: [...OPERATIONAL_STATES],
  identityStates: [...IDENTITY_STATES],
  visibilityClasses: [...VISIBILITY_CLASSES],
});
