import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";

function canPersist(store) {
  return typeof store?.upsertRetailerLocations === "function" || typeof store?.pool === "function";
}

function branchCandidate(shop = {}) {
  if (!shop?.retailerId || !shop?.provider || !shop?.providerPlaceId) return null;
  if (!Number.isFinite(Number(shop.latitude)) || !Number.isFinite(Number(shop.longitude))) return null;
  return {
    retailerId: shop.retailerId,
    provider: shop.provider,
    providerId: shop.providerPlaceId,
    name: shop.name,
    address: shop.address,
    postcode: shop.postcode || null,
    latitude: Number(shop.latitude),
    longitude: Number(shop.longitude),
    websiteUrl: shop.websiteUrl,
    verification: "provider_discovered",
    retailerCategory: shop.retailerCategory,
    storeFormat: shop.storeFormat,
    operationalStatus: shop.operationalStatus,
    tcgSellerStatus: shop.locationEvidence?.pokemonSeller,
    tcgSellerConfidence: shop.locationEvidence?.confidence,
    identityStatus: "provisional",
    lastVerifiedAt: Date.now(),
    openingDetails: {
      sourceAttribution: shop.sourceAttribution || "Live location discovery",
      stockStatus: "unknown",
      stockClaim: false,
    },
    updatedAt: Date.now(),
  };
}

export async function persistMatchedRetailerLocations(store, shops = []) {
  const candidates = (Array.isArray(shops) ? shops : []).map(branchCandidate).filter(Boolean);
  const normalized = normalizeRetailerLocationBatch(candidates);
  if (!normalized.locations.length) {
    return {
      status: "empty",
      saved: 0,
      rejected: normalized.rejected,
      received: candidates.length,
    };
  }
  if (!canPersist(store)) {
    return {
      status: "unconfigured",
      saved: 0,
      rejected: normalized.rejected,
      received: candidates.length,
    };
  }
  try {
    const result = await upsertRetailerLocationsIntoStore(store, normalized.locations);
    return {
      status: "ok",
      saved: Number(result?.saved || 0),
      rejected: normalized.rejected,
      received: candidates.length,
    };
  } catch (error) {
    return {
      status: "unavailable",
      saved: 0,
      rejected: normalized.rejected,
      received: candidates.length,
      error: String(error?.message || error),
    };
  }
}
