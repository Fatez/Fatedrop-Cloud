import {
  normalizeLocalStockObservationBatch,
  normalizeRetailerLocation,
  upsertLocalStockObservationsIntoStore,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";

const RETAILER_ID = "smyths-uk";
const IDENTIFIER_NAMESPACE = "smyths-uk:product_ref";
const SMYTHS_ORIGIN = "https://www.smythstoys.com";
const OFFICIAL_BRANCH_PROVIDER = "smyths_official_store_availability";
const IN_STOCK = new Set(["instock", "in_stock", "available", "collection_available", "on_shelf"]);
const LOW_STOCK = new Set(["lowstock", "low_stock", "limitedstock", "limited_stock"]);
const OUT_OF_STOCK = new Set(["outofstock", "out_of_stock", "unavailable", "soldout", "sold_out"]);
const SOURCE_GATE = new Map();

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalToken(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function smythsBranchKey(value) {
  return normalToken(value)
    .replace(/^smyths(?: toys)?(?: superstores?)?\s+/, "")
    .replace(/^smyths\s+/, "")
    .trim();
}

function postcodeFrom(value) {
  const raw = String(value || "").toUpperCase();
  const match = raw.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  return match ? match[1].replace(/\s+/g, "") : null;
}

function officialStoreName(record = {}) {
  return text(record.name ?? record.displayName ?? record.storeName ?? record.pointOfServiceName);
}

function officialStorePostcode(record = {}) {
  return postcodeFrom(
    record.postcode
    ?? record.postalCode
    ?? record.address?.postalCode
    ?? record.address?.postcode
    ?? record.address?.formattedAddress
    ?? record.formattedAddress,
  );
}

function officialStoreId(record = {}) {
  return text(record.id ?? record.storeId ?? record.pointOfServiceId ?? record.pointOfServiceName);
}

function officialStoreCoordinates(record = {}) {
  const latitude = number(
    record.geoPoint?.latitude
    ?? record.geoPoint?.lat
    ?? record.location?.latitude
    ?? record.location?.lat
    ?? record.coordinates?.latitude
    ?? record.coordinates?.lat
    ?? record.address?.latitude
    ?? record.latitude,
  );
  const longitude = number(
    record.geoPoint?.longitude
    ?? record.geoPoint?.lng
    ?? record.location?.longitude
    ?? record.location?.lng
    ?? record.coordinates?.longitude
    ?? record.coordinates?.lng
    ?? record.address?.longitude
    ?? record.longitude,
  );
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

function officialStoreAddress(record = {}) {
  return text(
    record.formattedAddress
    ?? record.address?.formattedAddress
    ?? record.address?.line1
    ?? record.address?.streetAddress
    ?? record.address?.town,
  );
}

function officialBranchFromStore(record = {}) {
  const name = officialStoreName(record);
  const officialId = officialStoreId(record);
  const postcode = officialStorePostcode(record);
  const coordinates = officialStoreCoordinates(record);
  if (!name || !coordinates) return null;

  // Prefer the retailer's own immutable store/POS identifier. If that field is not
  // present, only accept a deterministic compound identity when both branch name
  // and postcode are present. Never create a branch from a fuzzy name alone.
  const providerId = officialId || (postcode ? `${smythsBranchKey(name)}|${postcode}` : null);
  if (!providerId) return null;

  try {
    const location = normalizeRetailerLocation({
      retailerId: RETAILER_ID,
      provider: OFFICIAL_BRANCH_PROVIDER,
      providerId,
      name,
      address: officialStoreAddress(record),
      postcode,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      websiteUrl: SMYTHS_ORIGIN,
      verification: "official_retailer_branch",
    });
    return {
      ...location,
      branchKey: smythsBranchKey(location.name),
      postcodeKey: postcodeFrom(location.postcode || location.address),
    };
  } catch {
    return null;
  }
}

export function normalizeSmythsStockStatus(value) {
  const token = normalToken(value).replace(/\s+/g, "_");
  const compact = token.replace(/_/g, "");
  if (IN_STOCK.has(token) || IN_STOCK.has(compact)) return "in_stock";
  if (LOW_STOCK.has(token) || LOW_STOCK.has(compact)) return "low_stock";
  if (OUT_OF_STOCK.has(token) || OUT_OF_STOCK.has(compact)) return "out_of_stock";
  return "unknown";
}

export function buildSmythsStorePickupUrl({ productCode, latitude, longitude, selectedStore = null } = {}) {
  const code = text(productCode);
  const lat = number(latitude);
  const lng = number(longitude);
  if (!code) throw new Error("Smyths availability requires productCode");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Smyths availability requires latitude and longitude");
  const url = new URL("/api/uk/en-gb/store-pickup/pointOfServices", SMYTHS_ORIGIN);
  url.searchParams.set("productId", code);
  if (text(selectedStore)) url.searchParams.set("selectedStore", text(selectedStore));
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("searchThroughGeoPointFirst", "true");
  url.searchParams.set("cartPage", "false");
  return url.toString();
}

async function fetchJsonOnce(url, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        status: response.status === 429 ? "rate_limited" : (response.status === 401 || response.status === 403 ? "protected" : "unavailable"),
        httpStatus: response.status,
        data: null,
      };
    }
    const trimmed = body.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { status: "non_json", httpStatus: response.status, data: null };
    }
    try {
      return { status: "ok", httpStatus: response.status, data: JSON.parse(trimmed) };
    } catch {
      return { status: "invalid_json", httpStatus: response.status, data: null };
    }
  } catch (error) {
    return {
      status: error?.name === "AbortError" ? "timeout" : "unavailable",
      httpStatus: null,
      data: null,
      error: String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSmythsStoreAvailability({
  productCode,
  latitude,
  longitude,
  selectedStore = null,
  fetchImpl = fetch,
  timeoutMs = 4500,
} = {}) {
  const url = buildSmythsStorePickupUrl({ productCode, latitude, longitude, selectedStore });
  const result = await fetchJsonOnce(url, { fetchImpl, timeoutMs });
  if (result.status !== "ok") return { ...result, url, stores: [] };
  const stores = Array.isArray(result.data?.stores)
    ? result.data.stores
    : (Array.isArray(result.data) ? result.data : []);
  return { ...result, url, stores };
}

async function listVerifiedMappings(store) {
  if (typeof store?.listVerifiedSmythsProductMappings === "function") {
    return store.listVerifiedSmythsProductMappings();
  }
  if (typeof store?.pool !== "function") return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT
      i.product_identity_id AS "productIdentityId",
      i.identifier_value AS "productCode",
      i.source_url AS "sourceUrl",
      p.title AS "productTitle"
    FROM fatedrop_product_identifiers i
    JOIN fatedrop_product_identities p ON p.id=i.product_identity_id
    WHERE i.namespace=$1 AND i.verified_at IS NOT NULL
    ORDER BY i.observed_at DESC
  `, [IDENTIFIER_NAMESPACE]);
  return rows;
}

function canonicalSmythsBranches(shops = []) {
  const branches = [];
  for (const shop of Array.isArray(shops) ? shops : []) {
    if (shop?.retailerId !== RETAILER_ID) continue;
    if (!shop?.provider || !shop?.providerPlaceId) continue;
    try {
      const location = normalizeRetailerLocation({
        retailerId: RETAILER_ID,
        provider: shop.provider,
        providerId: shop.providerPlaceId,
        name: shop.name,
        address: shop.address,
        postcode: shop.postcode || postcodeFrom(shop.address),
        latitude: shop.latitude,
        longitude: shop.longitude,
        websiteUrl: shop.websiteUrl,
        verification: "provider_discovered",
      });
      branches.push({
        ...location,
        branchKey: smythsBranchKey(location.name),
        postcodeKey: postcodeFrom(location.postcode || location.address),
      });
    } catch {
      // Discovery data that cannot form an exact canonical branch is ignored.
    }
  }
  return branches;
}

function exactBranchForOfficialStore(record, branches) {
  const officialId = officialStoreId(record);
  if (officialId) {
    const idMatches = branches.filter((branch) => branch.provider === OFFICIAL_BRANCH_PROVIDER && branch.providerId === officialId);
    if (idMatches.length === 1) return idMatches[0];
  }
  const postcode = officialStorePostcode(record);
  if (postcode) {
    const postcodeMatches = branches.filter((branch) => branch.postcodeKey === postcode);
    if (postcodeMatches.length === 1) return postcodeMatches[0];
  }
  const key = smythsBranchKey(officialStoreName(record));
  if (!key) return null;
  const nameMatches = branches.filter((branch) => branch.branchKey === key);
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

function statusFromStore(record = {}) {
  return normalizeSmythsStockStatus(
    record.stockLevelStatusCode
    ?? record.stockStatusCode
    ?? record.stockStatusMessage
    ?? record.stockLevelStatus
    ?? record.availability,
  );
}

function gateKey(lat, lng, mappings) {
  const latitudeBucket = Math.round(lat * 100) / 100;
  const longitudeBucket = Math.round(lng * 100) / 100;
  const products = mappings.map((mapping) => mapping.productCode).sort().join(",");
  return `${latitudeBucket}|${longitudeBucket}|${products}`;
}

function canPersistLocations(store) {
  return typeof store?.upsertRetailerLocations === "function" || typeof store?.pool === "function";
}

async function persistOfficialBranches(store, branches = []) {
  if (!branches.length || !canPersistLocations(store)) return { saved: 0, status: branches.length ? "unconfigured" : "empty" };
  try {
    const result = await upsertRetailerLocationsIntoStore(store, branches);
    return { saved: Number(result?.saved || 0), status: "ok" };
  } catch (error) {
    return { saved: 0, status: "unavailable", error: String(error?.message || error) };
  }
}

function mergeBranches(current = [], additions = []) {
  const byId = new Map(current.map((branch) => [branch.id, branch]));
  for (const branch of additions) byId.set(branch.id, branch);
  return [...byId.values()];
}

export async function refreshSmythsLocalAvailability({
  store,
  shops = [],
  latitude,
  longitude,
  fetchImpl = fetch,
  timeoutMs = 4500,
  maxProducts = 3,
  minRefreshMs = 60_000,
  protectionCooldownMs = 15 * 60_000,
} = {}) {
  const lat = number(latitude);
  const lng = number(longitude);
  let branches = canonicalSmythsBranches(shops);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { provider: OFFICIAL_BRANCH_PROVIDER, status: "not_applicable", productsChecked: 0, observationsSaved: 0, branchesDiscovered: 0, branchesPersisted: 0, rejected: 0 };
  }

  const mappings = (await listVerifiedMappings(store)).filter((mapping) => text(mapping.productIdentityId) && text(mapping.productCode));
  if (!mappings.length) {
    return { provider: OFFICIAL_BRANCH_PROVIDER, status: "unconfigured", productsChecked: 0, observationsSaved: 0, branchesDiscovered: 0, branchesPersisted: 0, rejected: 0 };
  }

  const limit = Math.max(1, Math.min(10, Number(maxProducts) || 3));
  const selectedMappings = mappings.slice(0, limit);
  const key = gateKey(lat, lng, selectedMappings);
  const now = Date.now();
  const gate = SOURCE_GATE.get(key) || { lastAttemptAt: 0, blockedUntil: 0, lastStatus: null };
  if (gate.blockedUntil > now) {
    return {
      provider: OFFICIAL_BRANCH_PROVIDER,
      status: "cooldown",
      cooldownReason: gate.lastStatus,
      cooldownUntil: new Date(gate.blockedUntil).toISOString(),
      productsChecked: 0,
      observationsSaved: 0,
      branchesDiscovered: 0,
      branchesPersisted: 0,
      rejected: 0,
    };
  }
  if (Number(minRefreshMs) > 0 && now - gate.lastAttemptAt < Number(minRefreshMs)) {
    return { provider: OFFICIAL_BRANCH_PROVIDER, status: "cached", productsChecked: 0, observationsSaved: 0, branchesDiscovered: 0, branchesPersisted: 0, rejected: 0 };
  }
  SOURCE_GATE.set(key, { ...gate, lastAttemptAt: now });

  // Google Places remains useful for broad shop discovery, but it is not a
  // prerequisite for Smyths physical-stock intelligence. The official retailer
  // response can establish its own exact branch identity when it supplies an
  // immutable store/POS ID plus coordinates (or name+postcode plus coordinates).
  const selectedStore = branches[0]?.branchKey || null;
  const observations = [];
  const sourceStates = [];
  const officialBranchesById = new Map();
  let branchesPersisted = 0;
  let branchPersistenceStatus = "empty";

  for (const mapping of selectedMappings) {
    const response = await fetchSmythsStoreAvailability({
      productCode: mapping.productCode,
      latitude: lat,
      longitude: lng,
      selectedStore,
      fetchImpl,
      timeoutMs,
    });
    sourceStates.push(response.status);
    if (response.status !== "ok") continue;

    const discoveredThisResponse = [];
    for (const officialStore of response.stores) {
      const officialBranch = officialBranchFromStore(officialStore);
      if (!officialBranch || officialBranchesById.has(officialBranch.id)) continue;
      officialBranchesById.set(officialBranch.id, officialBranch);
      discoveredThisResponse.push(officialBranch);
    }
    if (discoveredThisResponse.length) {
      branches = mergeBranches(branches, discoveredThisResponse);
      const persisted = await persistOfficialBranches(store, discoveredThisResponse);
      branchesPersisted += persisted.saved;
      branchPersistenceStatus = persisted.status;
    }

    for (const officialStore of response.stores) {
      const branch = exactBranchForOfficialStore(officialStore, branches);
      if (!branch) continue;
      const stockStatus = statusFromStore(officialStore);
      if (stockStatus === "unknown") continue;
      const kind = stockStatus === "out_of_stock" ? "vanished" : "manifested";
      observations.push({
        kind,
        productIdentityId: mapping.productIdentityId,
        retailerId: RETAILER_ID,
        locationId: branch.id,
        occurredAt: Date.now(),
        evidence: {
          evidenceLevel: "official_collection",
          confidence: stockStatus === "low_stock" ? 0.96 : 0.99,
          sourceType: "retailer_store_availability",
          sourceId: `smyths-store-pickup:${mapping.productCode}:${officialStoreId(officialStore) || branch.providerId || branch.branchKey}`,
          sourceUrl: mapping.sourceUrl || response.url,
          stockStatus,
          availabilityVerified: stockStatus !== "out_of_stock",
          rawProductTitle: mapping.productTitle,
          retailerSku: mapping.productCode,
          officialBranchName: officialStoreName(officialStore),
          branchIdentitySource: branch.provider,
        },
      });
    }
  }

  const normalized = normalizeLocalStockObservationBatch(observations);
  let persistResult = { saved: 0, duplicates: 0, rejected: [] };
  if (normalized.observations.length) {
    persistResult = await upsertLocalStockObservationsIntoStore(store, normalized.observations);
  }
  const sourceOk = sourceStates.some((state) => state === "ok");
  const sourceBlocked = sourceStates.find((state) => ["protected", "rate_limited"].includes(state)) || null;
  const finalStatus = sourceOk ? "ok" : (sourceBlocked || "unavailable");
  SOURCE_GATE.set(key, {
    lastAttemptAt: now,
    blockedUntil: sourceBlocked ? now + Math.max(60_000, Number(protectionCooldownMs) || 15 * 60_000) : 0,
    lastStatus: finalStatus,
  });
  return {
    provider: OFFICIAL_BRANCH_PROVIDER,
    status: finalStatus,
    productsChecked: sourceStates.length,
    observationsSaved: Number(persistResult?.saved || 0),
    duplicates: Number(persistResult?.duplicates || 0),
    branchesDiscovered: officialBranchesById.size,
    branchesPersisted,
    branchPersistenceStatus,
    rejected: normalized.rejected.length + (Array.isArray(persistResult?.rejected) ? persistResult.rejected.length : 0),
    sourceStates,
  };
}

export const SMYTHS_LOCAL_SOURCE_POLICY = Object.freeze({
  retailerId: RETAILER_ID,
  identifierNamespace: IDENTIFIER_NAMESPACE,
  requestMode: "ordinary_public_request_only",
  retries: 0,
  minimumRefreshMs: 60_000,
  protectionCooldownMs: 15 * 60_000,
  protections: "fail_closed_no_bypass",
  branchIdentity: "official store/POS ID plus coordinates, or exact name+postcode plus coordinates; Google Places is optional discovery evidence",
  manifested: "verified identifier + exact branch + official collection availability only",
  vanished: "existing Local Radar persistence still requires prior Manifested history",
});
