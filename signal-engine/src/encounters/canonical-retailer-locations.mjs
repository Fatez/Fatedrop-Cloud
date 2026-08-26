function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function slug(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function distanceMiles(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthMiles = 3958.7613;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthMiles * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizeLocationRow(row = {}) {
  const latitude = number(row.latitude);
  const longitude = number(row.longitude);
  const retailerId = text(row.retailerId ?? row.retailer_id);
  const id = text(row.id);
  const provider = text(row.provider)?.toLowerCase();
  const name = text(row.name);
  if (!id || !retailerId || !provider || !name) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id,
    retailerId,
    provider,
    providerId: text(row.providerId ?? row.provider_id),
    name,
    address: text(row.address),
    postcode: text(row.postcode)?.toUpperCase() || null,
    latitude,
    longitude,
    website: text(row.website),
    phone: text(row.phone),
    openingDetails: row.openingDetails ?? row.opening_details_json ?? {},
    verification: text(row.verification) || "source_verified",
    updatedAt: number(row.updatedAt ?? row.updated_at),
  };
}

async function readLocationRows(store, limit) {
  if (typeof store?.listRetailerLocations === "function") {
    return (await store.listRetailerLocations({ limit })) || [];
  }
  if (typeof store?.pool !== "function") return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT id,retailer_id,provider,provider_id,name,address,postcode,latitude,longitude,website,phone,opening_details_json,verification,updated_at
    FROM fatedrop_retailer_locations
    ORDER BY updated_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

function locationToShop(location, { origin, availableByRetailer }) {
  const onlineOffers = Number(availableByRetailer?.get(location.retailerId) || 0);
  const providerAttribution = text(location.openingDetails?.sourceAttribution);
  const providerSourceUrl = text(location.openingDetails?.sourceUrl);
  return {
    id: location.id,
    itemType: "shop",
    provider: location.provider,
    providerPlaceId: location.providerId,
    name: location.name,
    address: location.address,
    postcode: location.postcode,
    latitude: location.latitude,
    longitude: location.longitude,
    websiteUrl: location.website,
    phone: location.phone,
    openingDetails: location.openingDetails,
    businessStatus: "unknown",
    verificationStatus: location.verification,
    discoveryScope: "canonical-branch",
    networkStatus: "live_connected",
    retailerId: location.retailerId,
    localStockStatus: "unknown",
    stockEvidence: onlineOffers > 0 ? "online_catalogue_only" : "none",
    onlineCatalogue: {
      availableOffers: onlineOffers,
      scope: "online-catalogue-not-branch-stock",
    },
    sourceAttribution: providerAttribution || "FateDrop canonical retailer branch registry",
    sourceUrl: providerSourceUrl,
    distanceMiles: origin ? distanceMiles(origin, location) : null,
    branchUpdatedAt: location.updatedAt,
  };
}

export async function listCanonicalRetailerLocationShops(store, {
  origin = null,
  postcode = null,
  radiusMiles = 25,
  availableByRetailer = new Map(),
  limit = 10000,
} = {}) {
  const safeLimit = Math.min(20000, Math.max(1, Number(limit) || 10000));
  const rows = await readLocationRows(store, safeLimit);
  const canonical = rows.map(normalizeLocationRow).filter(Boolean);
  const radius = Math.max(1, Math.min(100, Number(radiusMiles) || 25));
  const queryPostcode = postcodeKey(postcode);
  const shops = canonical
    .map((location) => locationToShop(location, { origin, availableByRetailer }))
    .filter((shop) => {
      if (origin) return shop.distanceMiles != null && shop.distanceMiles <= radius;
      if (queryPostcode) return postcodeKey(shop.postcode) === queryPostcode;
      return false;
    });
  return {
    provider: "fatedrop_retailer_locations",
    status: shops.length ? "ok" : canonical.length ? "out_of_radius" : "empty",
    totalKnown: canonical.length,
    shops,
  };
}

function sameBranch(a, b) {
  if (!a?.retailerId || !b?.retailerId || a.retailerId !== b.retailerId) return false;
  if (a.provider && b.provider && a.provider === b.provider && a.providerPlaceId && b.providerPlaceId) {
    return String(a.providerPlaceId) === String(b.providerPlaceId);
  }
  const aPostcode = postcodeKey(a.postcode);
  const bPostcode = postcodeKey(b.postcode);
  if (aPostcode && bPostcode && aPostcode === bPostcode) return true;
  const proximity = distanceMiles(a, b);
  if (proximity != null && proximity <= 0.12) return true;
  return Boolean(a.name && b.name && slug(a.name) === slug(b.name) && proximity != null && proximity <= 0.5);
}

export function mergeCanonicalRetailerShops(discoveredShops = [], canonicalShops = []) {
  const result = [...(Array.isArray(discoveredShops) ? discoveredShops : [])];
  for (const canonical of Array.isArray(canonicalShops) ? canonicalShops : []) {
    const index = result.findIndex((candidate) => sameBranch(candidate, canonical));
    if (index < 0) {
      result.push(canonical);
      continue;
    }
    const discovered = result[index];
    result[index] = {
      ...discovered,
      ...canonical,
      onlineCatalogue: canonical.onlineCatalogue || discovered.onlineCatalogue || null,
      stockEvidence: canonical.stockEvidence || discovered.stockEvidence || "none",
      businessStatus: discovered.businessStatus || canonical.businessStatus || "unknown",
      sourceAttribution: `${canonical.sourceAttribution}; ${discovered.sourceAttribution || "fresh discovery"}`,
    };
  }
  return result;
}
