import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import { geocodeUkPostcode } from "./national-branch-directory-sync.mjs";
import { CURATED_RETAILER_BRANCH_SEEDS } from "./curated-retailer-branch-seeds.mjs";

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

function stableProviderId(seed = {}) {
  const explicit = text(seed.providerId ?? seed.branchKey);
  if (explicit) return explicit;
  const postcode = text(seed.postcode)?.toUpperCase().replace(/\s+/g, "") || "no-postcode";
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

export async function runCuratedRetailerBranchSync({
  store,
  seeds = CURATED_RETAILER_BRANCH_SEEDS,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const input = Array.isArray(seeds) ? seeds : [];
  const candidates = [];
  const rejected = [];

  for (let index = 0; index < input.length; index += 1) {
    const seed = input[index] || {};
    const retailerId = text(seed.retailerId);
    const name = text(seed.name ?? seed.branchName);
    if (!retailerId || !name) {
      rejected.push({ index, retailerId, name, reason: "curated branch seed requires retailerId and name" });
      continue;
    }

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
      providerId: stableProviderId(seed),
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
    accepted: normalized.locations.length,
    saved: Number(persisted?.saved ?? normalized.locations.length) || 0,
    inserted: Number(persisted?.inserted ?? 0) || 0,
    updated: Number(persisted?.updated ?? 0) || 0,
    rejected,
  };
}
