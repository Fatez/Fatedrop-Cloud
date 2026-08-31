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
  const identityStatus = conflictStatus === "conflicted"
    ? "conflicted"
    : enumValue(record.identityStatus ?? record.identity_status, IDENTITY_STATES, "canonical");
  const sellerStatus = identityStatus === "conflicted"
    ? "conflicted"
    : enumValue(record.tcgSellerStatus ?? record.tcg_seller_status, SELLER_STATES, fallback.tcgSellerStatus);

  const retailerCategory = enumValue(
      record.retailerCategory ?? record.retailer_category,
      RETAILER_CATEGORIES,
      fallback.retailerCategory,
    );
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
    storeFormat: String(record.storeFormat ?? record.store_format ?? openingDetails?.storeFormat ?? "unknown").trim() || "unknown",
    operationalStatus: enumValue(
      record.operationalStatus ?? record.operational_status,
      OPERATIONAL_STATES,
      "unknown",
    ),
    tcgSellerStatus: sellerStatus,
    tcgSellerConfidence: sellerStatus === "conflicted"
      ? 0
      : confidence(record.tcgSellerConfidence ?? record.tcg_seller_confidence, fallback.tcgSellerConfidence),
    identityStatus,
    lastVerifiedAt: epochSeconds(record.lastVerifiedAt ?? record.last_verified_at),
    evidenceSourceCount: Math.max(0, Number(record.evidenceSourceCount ?? record.evidence_source_count) || 0),
  };
}

export function isRadarEligibleLocation(location = {}) {
  const policy = normalizeLocationPolicy(location);
  return policy.operationalStatus !== "closed"
    && policy.identityStatus !== "conflicted"
    && !["excluded", "conflicted"].includes(policy.tcgSellerStatus);
}

export function publicLocationEvidence(location = {}) {
  const policy = normalizeLocationPolicy(location);
  return {
    branchIdentity: policy.identityStatus,
    pokemonSeller: policy.tcgSellerStatus,
    confidence: policy.tcgSellerConfidence,
    sourceCount: policy.evidenceSourceCount,
    lastVerifiedAt: policy.lastVerifiedAt,
    caveat: policy.tcgSellerStatus === "verified"
      ? "Evidence supports Pokémon TCG sales at this branch; exact stock is still unknown until Manifested."
      : policy.tcgSellerStatus === "likely"
        ? "This branch belongs to a retailer associated with Pokémon TCG sales; branch participation is not verified."
        : "Branch location only; Pokémon TCG sales at this branch are not verified.",
  };
}

export const LOCATION_POLICY_ENUMS = Object.freeze({
  retailerCategories: [...RETAILER_CATEGORIES],
  retailerGroups: ["supermarkets", "large_retailers", "independents", "unclassified"],
  sellerStates: [...SELLER_STATES],
  operationalStates: [...OPERATIONAL_STATES],
  identityStates: [...IDENTITY_STATES],
});
