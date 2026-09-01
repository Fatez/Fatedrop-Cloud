import {
  classifyLocationQuality,
  isEchoEligibleLocation,
  isRadarEligibleLocation,
  locationServiceKind,
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
    ...normalizeLocationPolicy(row),
  };
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

function samePostcode(a, b) {
  const left = postcodeKey(a?.postcode);
  const right = postcodeKey(b?.postcode);
  return Boolean(left && right && left === right);
}

function plausibleParent(child, candidate) {
  if (!child?.retailerId || child.retailerId !== candidate?.retailerId) return false;
  if (child.id === candidate.id || locationServiceKind(candidate)) return false;
  const candidateQuality = classifyLocationQuality(candidate);
  if (["excluded", "unresolved"].includes(candidateQuality.visibilityClass)) return false;
  const proximity = distanceMiles(child, candidate);
  return samePostcode(child, candidate) || (proximity != null && proximity <= 0.2);
}

function duplicateBranch(a, b) {
  if (!a?.retailerId || a.retailerId !== b?.retailerId || a.id === b.id) return false;
  if (a.provider === b.provider && a.providerId && b.providerId && String(a.providerId) === String(b.providerId)) return true;
  const proximity = distanceMiles(a, b);
  if (proximity == null || proximity > 0.12) return false;
  if (samePostcode(a, b)) return true;
  return Boolean(a.name && b.name && slug(a.name) === slug(b.name));
}

function canonicalScore(location) {
  let score = 0;
  if (location.identityStatus === "canonical") score += 40;
  if (location.tcgSellerStatus === "verified") score += 20;
  if (/official/i.test(location.provider || "")) score += 15;
  if (/official/i.test(location.verification || "")) score += 10;
  score += Math.min(5, Number(location.evidenceSourceCount || 0));
  score += Math.min(9, Math.max(0, Number(location.updatedAt || 0) / 1_000_000_000));
  return score;
}

function attachQuality(location, overrides = {}) {
  const base = classifyLocationQuality(location);
  return {
    ...location,
    visibilityClass: overrides.visibilityClass || base.visibilityClass,
    visibilityReason: overrides.visibilityReason || base.reason,
    serviceKind: overrides.serviceKind ?? base.serviceKind ?? null,
    parentLocationId: overrides.parentLocationId || null,
    relationshipType: overrides.relationshipType || null,
  };
}

function disjointSet(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  function find(index) {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  }
  function union(left, right) {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  }
  return { find, union };
}

export function reconcileLocationQuality(locations = []) {
  const input = (Array.isArray(locations) ? locations : []).filter(Boolean);
  const reconciled = input.map((location) => attachQuality(location));

  for (let index = 0; index < reconciled.length; index += 1) {
    const location = reconciled[index];
    const serviceKind = locationServiceKind(location);
    if (!serviceKind) continue;
    const parents = reconciled.filter((candidate) => plausibleParent(location, candidate));
    if (parents.length === 1) {
      reconciled[index] = attachQuality(location, {
        visibilityClass: "directory-only",
        visibilityReason: serviceKind,
        serviceKind,
        parentLocationId: parents[0].id,
        relationshipType: "child_service",
      });
    } else if (parents.length > 1) {
      reconciled[index] = attachQuality(location, {
        visibilityClass: "unresolved",
        visibilityReason: `${serviceKind}_parent_ambiguous`,
        serviceKind,
        relationshipType: "child_service",
      });
    } else {
      reconciled[index] = attachQuality(location, {
        visibilityClass: "excluded",
        visibilityReason: serviceKind,
        serviceKind,
        relationshipType: "child_service",
      });
    }
  }

  const candidates = reconciled
    .map((location, index) => ({ location, index }))
    .filter(({ location }) => !location.serviceKind && location.visibilityReason !== "closed");
  const sets = disjointSet(candidates.length);
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (duplicateBranch(candidates[left].location, candidates[right].location)) sets.union(left, right);
    }
  }
  const groups = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = sets.find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(candidates[index]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) => canonicalScore(b.location) - canonicalScore(a.location))[0];
    for (const drop of group) {
      if (drop.index === keep.index) continue;
      reconciled[drop.index] = attachQuality(reconciled[drop.index], {
        visibilityClass: "excluded",
        visibilityReason: "duplicate",
        parentLocationId: reconciled[keep.index].id,
        relationshipType: "duplicate_of",
      });
    }
  }
  // Duplicate identity is resolved before a child service is allowed to choose its parent.
  // This prevents a pharmacy/locker at the same postcode from seeing both the canonical
  // supermarket and its duplicate as two parents and becoming falsely unresolved.
  for (let index = 0; index < reconciled.length; index += 1) {
    const current = reconciled[index];
    const serviceKind = locationServiceKind(current);
    if (!serviceKind || current.relationshipType !== "child_service") continue;
    if (current.visibilityClass !== "unresolved" || !String(current.visibilityReason || "").endsWith("_parent_ambiguous")) continue;
    const parents = reconciled.filter((candidate) => plausibleParent(current, candidate));
    if (parents.length === 1) {
      reconciled[index] = attachQuality(current, {
        visibilityClass: "directory-only",
        visibilityReason: serviceKind,
        serviceKind,
        parentLocationId: parents[0].id,
        relationshipType: "child_service",
      });
    }
  }

  return reconciled;
}

function oldPublicEligible(location = {}) {
  const policy = normalizeLocationPolicy(location);
  return policy.operationalStatus !== "closed"
    && policy.identityStatus !== "conflicted"
    && !["excluded", "conflicted"].includes(policy.tcgSellerStatus);
}

function emptyAudit(retailerId) {
  return {
    retailerId,
    rawTotal: 0,
    beforePublic: 0,
    eligible: 0,
    directoryOnly: 0,
    excluded: 0,
    unresolved: 0,
    afterPublic: 0,
    echoEligible: 0,
    deltaPublic: 0,
    reasons: {},
  };
}

async function loadQualityAuditState(store, { retailerIds = [], limit = 20000 } = {}) {
  const safeLimit = Math.min(20000, Math.max(1, Number(limit) || 20000));
  const wanted = [...new Set((Array.isArray(retailerIds) ? retailerIds : []).map((value) => text(value)).filter(Boolean))];
  const wantedSet = new Set(wanted);
  const rows = await readLocationRows(store, { limit: safeLimit, retailerIds: wanted });
  const summaries = new Map();
  for (const row of rows) {
    const retailerId = text(row.retailerId ?? row.retailer_id);
    if (!retailerId || (wantedSet.size && !wantedSet.has(retailerId))) continue;
    const summary = summaries.get(retailerId) || emptyAudit(retailerId);
    summary.rawTotal += 1;
    summaries.set(retailerId, summary);
  }

  const normalized = rows
    .map(normalizeLocationRow)
    .filter(Boolean)
    .filter((location) => !wantedSet.size || wantedSet.has(location.retailerId));
  for (const location of normalized) {
    const summary = summaries.get(location.retailerId) || emptyAudit(location.retailerId);
    if (oldPublicEligible(location)) summary.beforePublic += 1;
    summaries.set(location.retailerId, summary);
  }

  const reconciled = reconcileLocationQuality(normalized);
  for (const location of reconciled) {
    const summary = summaries.get(location.retailerId) || emptyAudit(location.retailerId);
    if (location.visibilityClass === "eligible") summary.eligible += 1;
    else if (location.visibilityClass === "directory-only") summary.directoryOnly += 1;
    else if (location.visibilityClass === "excluded") summary.excluded += 1;
    else summary.unresolved += 1;
    summary.reasons[location.visibilityReason] = Number(summary.reasons[location.visibilityReason] || 0) + 1;
    summaries.set(location.retailerId, summary);
  }

  for (const summary of summaries.values()) {
    const classified = summary.eligible + summary.directoryOnly + summary.excluded + summary.unresolved;
    if (summary.rawTotal > classified) {
      const invalid = summary.rawTotal - classified;
      summary.unresolved += invalid;
      summary.reasons.invalid_location_record = Number(summary.reasons.invalid_location_record || 0) + invalid;
    }
    summary.afterPublic = summary.eligible;
    summary.deltaPublic = summary.afterPublic - summary.beforePublic;
  }
  return { rows, normalized, reconciled, summaries };
}

export async function auditCanonicalRetailerLocationQuality(store, options = {}) {
  const state = await loadQualityAuditState(store, options);
  return [...state.summaries.values()].sort((a, b) => a.retailerId.localeCompare(b.retailerId));
}

export async function buildCanonicalRetailerLocationQualityReview(store, {
  retailerIds = [],
  limit = 20000,
  echoEvents = [],
  now = Date.now(),
  sampleLimit = 25,
} = {}) {
  const state = await loadQualityAuditState(store, { retailerIds, limit });
  const byId = new Map(state.reconciled.map((location) => [location.id, location]));
  const echoIds = new Set();
  for (const event of Array.isArray(echoEvents) ? echoEvents : []) {
    const locationId = text(event.locationId ?? event.location_id);
    const location = locationId ? byId.get(locationId) : null;
    if (!location || !isEchoEligibleLocation(location, event, now)) continue;
    echoIds.add(location.id);
  }
  for (const locationId of echoIds) {
    const location = byId.get(locationId);
    const summary = state.summaries.get(location.retailerId);
    if (summary) summary.echoEligible += 1;
  }

  const removedSamples = state.reconciled
    .filter((location) => oldPublicEligible(location) && location.visibilityClass !== "eligible")
    .slice(0, Math.max(1, Number(sampleLimit) || 25))
    .map((location) => ({
      id: location.id,
      retailerId: location.retailerId,
      name: location.name,
      postcode: location.postcode,
      visibilityClass: location.visibilityClass,
      reason: location.visibilityReason,
      parentLocationId: location.parentLocationId,
    }));
  const reconciliations = state.reconciled
    .filter((location) => location.relationshipType)
    .map((location) => ({
      id: location.id,
      retailerId: location.retailerId,
      name: location.name,
      relationshipType: location.relationshipType,
      parentLocationId: location.parentLocationId,
      reason: location.visibilityReason,
    }));
  const unresolved = state.reconciled
    .filter((location) => location.visibilityClass === "unresolved")
    .slice(0, Math.max(1, Number(sampleLimit) || 25))
    .map((location) => ({
      id: location.id,
      retailerId: location.retailerId,
      name: location.name,
      postcode: location.postcode,
      reason: location.visibilityReason,
    }));

  return {
    retailers: [...state.summaries.values()].sort((a, b) => a.retailerId.localeCompare(b.retailerId)),
    removedSamples,
    reconciliations,
    unresolved,
    echoEligibleBranchCount: echoIds.size,
    truthRule: "Review-only classification. Raw locations, stock observations and lifecycle history remain unchanged; campaign expiry removes Echo authority without creating Vanished.",
  };
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
  const normalized = rows
    .map(normalizeLocationRow)
    .filter(Boolean)
    .filter((location) => !wanted.size || wanted.has(location.retailerId));
  return reconcileLocationQuality(normalized).filter(isRadarEligibleLocation);
}

export async function countCanonicalRetailerLocations(store, {
  retailerIds = [],
  limit = 20000,
} = {}) {
  const audit = await auditCanonicalRetailerLocationQuality(store, { retailerIds, limit });
  return new Map(audit.map((row) => [row.retailerId, row.afterPublic]));
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
    visibilityClass: location.visibilityClass,
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
