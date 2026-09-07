import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import { geocodeUkPostcode } from "./national-branch-directory-sync.mjs";
import {
  CURATED_MANUAL_RETAILER_BRANCH_SEEDS,
  CURATED_MANUAL_RETAILER_REGISTRY_SEEDS,
} from "./curated-retailer-manual-branch-seeds.mjs";
import { PostgresRetailerRegistry } from "../retailers/postgres-registry.mjs";

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function slug(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function websiteHostname(value) {
  const raw = text(value);
  if (!raw) return null;
  try { return new URL(raw).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

function stableProviderId(seed = {}) {
  const explicit = text(seed.providerId ?? seed.branchKey);
  if (explicit) return explicit;
  const postcode = postcodeKey(seed.postcode) || "no-postcode";
  return `${slug(seed.branchName ?? seed.name ?? "branch")}:${postcode}`;
}

async function resolveCoordinates(seed, { fetchImpl }) {
  const latitude = number(seed.latitude);
  const longitude = number(seed.longitude);
  if (latitude != null && longitude != null) return { latitude, longitude, geocode: null };
  const postcode = text(seed.postcode);
  if (!postcode) return null;
  const geocoded = await geocodeUkPostcode(postcode, { fetchImpl });
  if (!geocoded) return null;
  return { ...geocoded, geocode: "postcodes.io" };
}

function rowRetailerId(row = {}) {
  return text(row.retailerId ?? row.retailer_id);
}

async function listExistingLocations(store) {
  if (typeof store?.listRetailerLocations === "function") {
    return (await store.listRetailerLocations({ limit: 20000 })) || [];
  }
  if (typeof store?.pool !== "function") return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT id,retailer_id,provider,provider_id,name,address,postcode,latitude,longitude
    FROM fatedrop_retailer_locations
    ORDER BY updated_at DESC
    LIMIT 20000
  `);
  return rows;
}

async function ensureCuratedManualRetailers(store, registrySeeds = CURATED_MANUAL_RETAILER_REGISTRY_SEEDS) {
  const configured = Array.isArray(registrySeeds) ? registrySeeds : [];
  const aliases = new Map(configured.map((seed) => [text(seed?.id), text(seed?.id)]).filter(([id]) => id));
  if (!configured.length || typeof store?.pool !== "function") {
    return { configured: configured.length, inserted: 0, alreadyKnown: 0, aliases };
  }

  const registry = new PostgresRetailerRegistry("", { poolProvider: () => store.pool() });
  const existing = await registry.list({ limit: 5000 });
  let inserted = 0;
  let alreadyKnown = 0;

  for (const seed of configured) {
    const desiredId = text(seed?.id);
    if (!desiredId) continue;
    const desiredHost = websiteHostname(seed.websiteUrl);
    const match = existing.find((candidate) => candidate.id === desiredId)
      || (desiredHost ? existing.find((candidate) => websiteHostname(candidate.websiteUrl) === desiredHost) : null);
    if (match) {
      aliases.set(desiredId, match.id);
      alreadyKnown += 1;
      continue;
    }
    const saved = await registry.upsert(seed);
    existing.push(saved);
    aliases.set(desiredId, saved.id);
    inserted += 1;
  }

  return { configured: configured.length, inserted, alreadyKnown, aliases };
}

function canonicalBranchKey(retailerId, postcode) {
  const retailer = text(retailerId);
  const postcodeId = postcodeKey(postcode);
  return retailer && postcodeId ? `${retailer}|${postcodeId}` : null;
}

export async function runCuratedRetailerBranchSync({
  store,
  seeds = CURATED_MANUAL_RETAILER_BRANCH_SEEDS,
  registrySeeds = CURATED_MANUAL_RETAILER_REGISTRY_SEEDS,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Curated retailer branch sync requires a store");
  const input = Array.isArray(seeds) ? seeds : [];
  const candidates = [];
  const rejected = [];

  const retailerRegistry = await ensureCuratedManualRetailers(store, registrySeeds);
  const existing = await listExistingLocations(store);
  const knownBranchKeys = new Set(existing
    .map((row) => canonicalBranchKey(rowRetailerId(row), row.postcode))
    .filter(Boolean));
  let alreadyKnown = 0;
  let duplicateSeeds = 0;

  for (let index = 0; index < input.length; index += 1) {
    const seed = input[index] || {};
    const requestedRetailerId = text(seed.retailerId);
    const retailerId = retailerRegistry.aliases.get(requestedRetailerId) || requestedRetailerId;
    const name = text(seed.name ?? seed.branchName);
    if (!retailerId || !name) {
      rejected.push({ index, retailerId, name, reason: "curated branch seed requires retailerId and name" });
      continue;
    }

    const branchKey = canonicalBranchKey(retailerId, seed.postcode);
    if (branchKey && knownBranchKeys.has(branchKey)) {
      if (existing.some((row) => canonicalBranchKey(rowRetailerId(row), row.postcode) === branchKey)) alreadyKnown += 1;
      else duplicateSeeds += 1;
      continue;
    }
    if (branchKey) knownBranchKeys.add(branchKey);

    let coordinates = null;
    try {
      coordinates = await resolveCoordinates(seed, { fetchImpl });
    } catch (error) {
      rejected.push({ index, retailerId, name, reason: `coordinate lookup failed: ${String(error?.message || error)}` });
      continue;
    }
    if (!coordinates) {
      rejected.push({ index, retailerId, name, reason: "curated branch seed requires coordinates or a geocodable postcode" });
      continue;
    }

    const sourceUrl = text(seed.sourceUrl ?? seed.website);
    const sourceType = text(seed.sourceType) || "curated_branch_seed";
    const sourceAttribution = text(seed.sourceAttribution) || "FateDrop curated physical retailer directory";
    candidates.push({
      retailerId,
      provider: "fatedrop_curated_branch",
      providerId: stableProviderId({ ...seed, retailerId }),
      name,
      address: text(seed.address),
      postcode: text(seed.postcode)?.toUpperCase() || null,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      website: text(seed.website),
      phone: text(seed.phone),
      verification: text(seed.verification) || "curated_branch",
      updatedAt: now,
      openingDetails: {
        sourceType,
        sourceUrl,
        sourceAttribution,
        sourceObservedAt: text(seed.sourceObservedAt) || new Date(now).toISOString(),
        physicalRetailer: true,
        supportedTcgs: Array.isArray(seed.supportedTcgs) ? seed.supportedTcgs : ["pokemon"],
        stockStatus: "unknown",
        stockClaim: false,
        ...(coordinates.geocode ? { coordinateSource: coordinates.geocode } : {}),
        ...(text(seed.notes) ? { notes: text(seed.notes) } : {}),
      },
    });
  }

  const normalized = normalizeRetailerLocationBatch(candidates);
  rejected.push(...normalized.rejected.map((row) => ({ ...row, reason: `normalization: ${row.reason}` })));
  const persisted = normalized.locations.length
    ? await upsertRetailerLocationsIntoStore(store, normalized.locations)
    : { saved: 0, inserted: 0, updated: 0 };

  return {
    provider: "fatedrop_curated_branch",
    status: normalized.locations.length ? "ok" : input.length ? "empty" : "no_seeds",
    configured: input.length,
    alreadyKnown,
    duplicateSeeds,
    accepted: normalized.locations.length,
    saved: Number(persisted?.saved ?? normalized.locations.length) || 0,
    inserted: Number(persisted?.inserted ?? 0) || 0,
    updated: Number(persisted?.updated ?? 0) || 0,
    retailerRegistry: {
      configured: retailerRegistry.configured,
      inserted: retailerRegistry.inserted,
      alreadyKnown: retailerRegistry.alreadyKnown,
    },
    rejected,
  };
}
