import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const DEFAULT_SAVE_LIMIT = 750;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function normalized(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function httpUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function addressFromTags(tags = {}) {
  const street = [text(tags["addr:housenumber"]), text(tags["addr:street"])].filter(Boolean).join(" ");
  const parts = [street || null, text(tags["addr:place"]), text(tags["addr:city"]), text(tags["addr:town"]), text(tags["addr:suburb"]), text(tags["addr:postcode"])].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(", ") : null;
}

function isInactive(tags = {}) {
  const keys = Object.keys(tags);
  if (keys.some((key) => /^(?:disused|abandoned|demolished|removed|razed):/.test(key))) return true;
  const state = normalized(tags.disused || tags.abandoned || tags.demolished || tags.closed || "");
  return ["yes", "true", "1"].includes(state);
}

function chainIdentity(tags = {}) {
  const name = normalized(tags.name);
  const brand = normalized(tags.brand);
  const operator = normalized(tags.operator);
  const values = [brand, name, operator].filter(Boolean);

  const tesco = values.some((value) => value === "tesco" || value.startsWith("tesco extra") || value.startsWith("tesco superstore"));
  const tescoSmallFormat = values.some((value) => value.includes("tesco express") || value.includes("tesco petrol") || value.includes("tesco phone shop"));
  if (tesco && !tescoSmallFormat) return { retailerId: "tesco-uk", canonicalName: text(tags.name) || "Tesco" };

  if (values.some((value) => value === "argos" || value.startsWith("argos in ") || value.startsWith("argos inside "))) {
    return { retailerId: "argos-uk", canonicalName: text(tags.name) || "Argos" };
  }

  if (values.some((value) => value === "the entertainer" || value.startsWith("the entertainer "))) {
    return { retailerId: "entertainer-uk", canonicalName: text(tags.name) || "The Entertainer" };
  }

  if (values.some((value) => value === "smyths toys" || value.startsWith("smyths toys ") || value === "smyths toys superstores")) {
    return { retailerId: "smyths-uk", canonicalName: text(tags.name) || "Smyths Toys" };
  }

  return null;
}

export function buildKnownChainOverpassQuery() {
  return `[out:json][timeout:60];
area["ISO3166-1"="GB"][boundary=administrative]->.uk;
(
  nwr["brand"~"^(Tesco|Argos|The Entertainer|Smyths Toys.*)$",i](area.uk);
  nwr["name"~"^(Tesco|Tesco Extra|Tesco Superstore|Argos.*|The Entertainer.*|Smyths Toys.*)$",i](area.uk);
);
out center tags;`;
}

function elementToLocation(element = {}, now = Date.now()) {
  const tags = element.tags && typeof element.tags === "object" ? element.tags : {};
  if (isInactive(tags)) return null;
  const identity = chainIdentity(tags);
  if (!identity) return null;
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const type = text(element.type)?.toLowerCase();
  const id = text(element.id);
  if (!type || !id || !["node", "way", "relation"].includes(type)) return null;
  const sourceUrl = `https://www.openstreetmap.org/${type}/${id}`;
  return {
    retailerId: identity.retailerId,
    provider: "openstreetmap",
    providerId: `${type}/${id}`,
    name: identity.canonicalName,
    address: addressFromTags(tags),
    postcode: text(tags["addr:postcode"])?.toUpperCase() || null,
    latitude,
    longitude,
    websiteUrl: httpUrl(tags.website || tags["contact:website"]),
    phone: text(tags.phone || tags["contact:phone"]),
    openingDetails: {
      sourceAttribution: OSM_ATTRIBUTION,
      sourceUrl,
      sourceType: "geographic_provider",
      sourceObservedAt: new Date(now).toISOString(),
    },
    verification: "provider_discovered",
    updatedAt: now,
  };
}

export function normalizeOverpassBranchElements(elements = [], { now = Date.now() } = {}) {
  const byProviderId = new Map();
  const rejected = [];
  for (const element of Array.isArray(elements) ? elements : []) {
    const location = elementToLocation(element, now);
    if (!location) {
      rejected.push({ type: text(element?.type), id: text(element?.id), reason: "not_supported_or_incomplete" });
      continue;
    }
    byProviderId.set(location.providerId, location);
  }
  return { locations: [...byProviderId.values()], rejected };
}

async function knownOsmProviderIds(store) {
  if (typeof store?.listRetailerLocations === "function") {
    const rows = await store.listRetailerLocations({ limit: 20000 });
    return new Set((rows || [])
      .filter((row) => row.provider === "openstreetmap")
      .map((row) => String(row.providerId ?? row.provider_id || ""))
      .filter(Boolean));
  }
  if (typeof store?.pool !== "function") return new Set();
  const pool = await store.pool();
  const { rows } = await pool.query("SELECT provider_id FROM fatedrop_retailer_locations WHERE provider='openstreetmap'");
  return new Set(rows.map((row) => String(row.provider_id || "")).filter(Boolean));
}

export async function fetchKnownChainOverpass({ fetchImpl = fetch, timeoutMs = 75_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ data: buildKnownChainOverpassQuery() });
    const response = await fetchImpl(OVERPASS_URL, {
      method: "POST",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": "FateDrop-LocalRadar/1.0 (+https://fatedrop.co.uk)",
      },
      body: body.toString(),
    });
    if (!response.ok) throw new Error(`OpenStreetMap Overpass unavailable (${response.status})`);
    const payload = await response.json();
    return Array.isArray(payload?.elements) ? payload.elements : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function runOsmRetailerBranchSync({
  store,
  fetchImpl = fetch,
  saveLimit = DEFAULT_SAVE_LIMIT,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("OSM retailer branch sync requires a store");
  let elements;
  try {
    elements = await fetchKnownChainOverpass({ fetchImpl });
  } catch (error) {
    return {
      provider: "openstreetmap",
      status: "unavailable",
      discovered: 0,
      accepted: 0,
      saved: 0,
      rejected: 0,
      error: String(error?.message || error),
      truthRule: "Geographic discovery establishes branch presence only; it never establishes Pokémon stock or Local Manifested.",
    };
  }

  const normalized = normalizeOverpassBranchElements(elements, { now });
  const known = await knownOsmProviderIds(store).catch(() => new Set());
  const maxSave = Math.min(2000, Math.max(1, Number(saveLimit) || DEFAULT_SAVE_LIMIT));
  const pending = normalized.locations.filter((row) => !known.has(row.providerId)).slice(0, maxSave);
  const batch = normalizeRetailerLocationBatch(pending);
  let saved = 0;
  let persistenceRejected = [];
  if (batch.locations.length) {
    try {
      const result = await upsertRetailerLocationsIntoStore(store, batch.locations);
      saved = Number(result?.saved || 0);
    } catch (error) {
      return {
        provider: "openstreetmap",
        status: "persistence_unavailable",
        discovered: elements.length,
        accepted: normalized.locations.length,
        attempted: pending.length,
        saved: 0,
        rejected: normalized.rejected.length + batch.rejected.length,
        error: String(error?.message || error),
        attribution: OSM_ATTRIBUTION,
        truthRule: "Geographic discovery establishes branch presence only; it never establishes Pokémon stock or Local Manifested.",
      };
    }
    persistenceRejected = batch.rejected;
  }

  const countsByRetailer = {};
  for (const row of normalized.locations) countsByRetailer[row.retailerId] = (countsByRetailer[row.retailerId] || 0) + 1;
  return {
    provider: "openstreetmap",
    status: "ok",
    discovered: elements.length,
    accepted: normalized.locations.length,
    alreadyKnown: normalized.locations.length - pending.length,
    attempted: pending.length,
    saved,
    rejected: normalized.rejected.length + persistenceRejected.length,
    countsByRetailer,
    attribution: OSM_ATTRIBUTION,
    truthRule: "Geographic discovery establishes branch presence only; it never establishes Pokémon stock or Local Manifested.",
  };
}
