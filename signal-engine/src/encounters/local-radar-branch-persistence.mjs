import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import { locationServiceKind } from "./local-radar-location-policy.mjs";

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
  const input = Array.isArray(shops) ? shops : [];
  const blocked = input
    .filter((shop) => shop?.retailerId && locationServiceKind(shop))
    .map((shop) => ({ name: shop.name || null, retailerId: shop.retailerId, reason: `service_location:${locationServiceKind(shop)}` }));
  const candidates = input
    .filter((shop) => !locationServiceKind(shop))
    .map(branchCandidate)
    .filter(Boolean);
  const normalized = normalizeRetailerLocationBatch(candidates);
  const rejected = [...blocked, ...normalized.rejected];
  if (!normalized.locations.length) {
    return {
      status: "empty",
      saved: 0,
      rejected,
      received: input.length,
    };
  }
  if (!canPersist(store)) {
    return {
      status: "unconfigured",
      saved: 0,
      rejected,
      received: input.length,
    };
  }
  try {
    const result = await upsertRetailerLocationsIntoStore(store, normalized.locations);
    return {
      status: "ok",
      saved: Number(result?.saved || 0),
      rejected,
      received: input.length,
    };
  } catch (error) {
    return {
      status: "unavailable",
      saved: 0,
      rejected,
      received: input.length,
      error: String(error?.message || error),
    };
  }
}
