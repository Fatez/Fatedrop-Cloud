import {
  isRadarEligibleLocation,
  normalizeLocationPolicy,
  publicLocationEvidence,
} from "./local-radar-location-policy.mjs";

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

export function radiusBoundingBox(origin, radiusMiles) {
  if (![origin?.latitude, origin?.longitude].every(Number.isFinite)) return null;
  const radius = Math.max(1, Math.min(100, Number(radiusMiles) || 25));
  const latitudeDelta = radius / 69;
  const longitudeMiles = Math.max(1, 69.172 * Math.cos(origin.latitude * Math.PI / 180));
  const longitudeDelta = radius / longitudeMiles;
  return {
    minLatitude: Math.max(-90, origin.latitude - latitudeDelta),
    maxLatitude: Math.min(90, origin.latitude + latitudeDelta),
    minLongitude: Math.max(-180, origin.longitude - longitudeDelta),
    maxLongitude: Math.min(180, origin.longitude + longitudeDelta),
  };
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
  const normalized = {
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
    ...normalizeLocationPolicy(row),
  };
  return normalized;
}

async function readLocationRows(store, { limit, bounds = null, postcode = null, retailerIds = [] }) {
  if (typeof store?.listRetailerLocations === "function") {
    return (await store.listRetailerLocations({ limit, bounds, postcode, retailerIds })) || [];
  }
  if (typeof store?.pool !== "function") return [];
  const pool = await store.pool();
  const params = [];
  const where = [];
  if (bounds) {
    params.push(bounds.minLatitude, bounds.maxLatitude, bounds.minLongitude, bounds.maxLongitude);
    where.push(`latitude BETWEEN $${params.length - 3} AND $${params.length - 2}`);
    where.push(`longitude BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (postcode) {
    params.push(postcode);
    where.push(`UPPER(REPLACE(postcode, ' ', '')) = $${params.length}`);
  }
  if (retailerIds.length) {
    params.push(retailerIds);
    where.push(`retailer_id = ANY($${params.length}::text[])`);
  }
  params.push(limit);
  const { rows } = await pool.query(`
    SELECT
      l.id,l.retailer_id,l.provider,l.provider_id,l.name,l.address,l.postcode,l.latitude,l.longitude,
      l.website,l.phone,l.opening_details_json,l.verification,l.updated_at,l.retailer_category,l.store_format,
      l.operational_status,l.tcg_seller_status,l.tcg_seller_confidence,l.identity_status,l.last_verified_at,
      (SELECT COUNT(*)::int FROM fatedrop_retailer_location_sources s
       WHERE s.location_id=l.id AND s.status='accepted') AS evidence_source_count
    FROM fatedrop_retailer_locations l
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC
    LIMIT $${params.length}
  `, params);
  return rows;
}

export async function listCanonicalRetailerLocations(store, {
  retailerIds = [],
  limit = 10000,
  bounds = null,
  postcode = null,
} = {}) {
  const safeLimit = Math.min(20000, Math.max(1, Number(limit) || 10000));
  const wantedValues = (Array.isArray(retailerIds) ? retailerIds : []).map((value) => text(value)).filter(Boolean);
  const wanted = new Set(wantedValues);
  const rows = await readLocationRows(store, {
    limit: safeLimit,
    bounds,
    postcode: postcodeKey(postcode) || null,
    retailerIds: wantedValues,
  });
  return rows
    .map(normalizeLocationRow)
    .filter(Boolean)
    .filter(isRadarEligibleLocation)
    .filter((location) => !wanted.size || wanted.has(location.retailerId));
}

export async function countCanonicalRetailerLocations(store, {
  retailerIds = [],
  limit = 20000,
} = {}) {
  const wanted = [...new Set((Array.isArray(retailerIds) ? retailerIds : []).map((value) => text(value)).filter(Boolean))];
  if (typeof store?.pool === "function") {
    const pool = await store.pool();
    const params = [];
    const eligibility = "operational_status <> 'closed' AND identity_status <> 'conflicted' AND tcg_seller_status NOT IN ('excluded','conflicted')";
    const where = wanted.length ? `WHERE retailer_id = ANY($1::text[]) AND ${eligibility}` : `WHERE ${eligibility}`;
    if (wanted.length) params.push(wanted);
    const { rows } = await pool.query(`
      SELECT retailer_id,COUNT(*)::int AS location_count
      FROM fatedrop_retailer_locations
      ${where}
      GROUP BY retailer_id
    `, params);
    return new Map(rows.map((row) => [String(row.retailer_id), Number(row.location_count) || 0]));
  }

  const locations = await listCanonicalRetailerLocations(store, { retailerIds: wanted, limit });
  const counts = new Map();
  for (const location of locations) {
    counts.set(location.retailerId, Number(counts.get(location.retailerId) || 0) + 1);
  }
  return counts;
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
    retailerCategory: location.retailerCategory,
    retailerGroup: location.retailerGroup,
    storeFormat: location.storeFormat,
    operationalStatus: location.operationalStatus,
    locationEvidence: publicLocationEvidence(location),
  };
}

export async function listCanonicalRetailerLocationShops(store, {
  origin = null,
  postcode = null,
  radiusMiles = 25,
  availableByRetailer = new Map(),
  limit = 10000,
} = {}) {
  const radius = Math.max(1, Math.min(100, Number(radiusMiles) || 25));
  const queryPostcode = postcodeKey(postcode);
  const bounds = origin ? radiusBoundingBox(origin, radius) : null;
  const [canonical, knownCounts] = await Promise.all([
    listCanonicalRetailerLocations(store, { limit, bounds, postcode: queryPostcode || null }),
    countCanonicalRetailerLocations(store),
  ]);
  const totalKnown = [...knownCounts.values()].reduce((sum, value) => sum + value, 0);
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
    totalKnown,
    boundedCandidates: canonical.length,
    truncated: canonical.length >= Math.min(20000, Math.max(1, Number(limit) || 10000)),
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
  const proximity = distanceMiles(a, b);
  if (proximity != null && proximity <= 0.12) return true;
  if (aPostcode && bPostcode && aPostcode === bPostcode && proximity != null && proximity <= 0.5) return true;
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
