import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import { geocodeUkPostcode } from "./national-branch-directory-sync.mjs";

const PROVIDER = "fatedrop_official_retailer_branch_seed";
const VERIFIED_AT = "2026-08-27T01:48:00+01:00";

// Official retailer-source branch identities for monitored specialist/local businesses.
// These rows establish physical business presence only. They never carry stock evidence.
export const CURATED_NETWORK_RETAILER_BRANCH_SEEDS = Object.freeze([
  Object.freeze({
    retailerId: "travelling-man-uk",
    providerId: "travelling-man-uk:leeds:LS1-6DE",
    name: "Travelling Man Leeds",
    address: "32 Central Road, Leeds",
    postcode: "LS1 6DE",
    phone: "0113 3452420",
    sourceUrl: "https://travellingman.com/pages/our-shops",
    sourceAttribution: "Travelling Man official stores page",
  }),
  Object.freeze({
    retailerId: "travelling-man-uk",
    providerId: "travelling-man-uk:york:YO1-7LF",
    name: "Travelling Man York",
    address: "74 Goodramgate, York",
    postcode: "YO1 7LF",
    phone: "01904 849050",
    sourceUrl: "https://travellingman.com/pages/our-shops",
    sourceAttribution: "Travelling Man official stores page",
  }),
  Object.freeze({
    retailerId: "travelling-man-uk",
    providerId: "travelling-man-uk:newcastle:NE1-5JE",
    name: "Travelling Man Newcastle",
    address: "43 Grainger Street, Newcastle Upon Tyne",
    postcode: "NE1 5JE",
    phone: "0191 2614993",
    sourceUrl: "https://travellingman.com/pages/our-shops",
    sourceAttribution: "Travelling Man official stores page",
  }),
  Object.freeze({
    retailerId: "travelling-man-uk",
    providerId: "travelling-man-uk:manchester:M1-1JW",
    name: "Travelling Man Manchester",
    address: "4 Dale Street, Manchester",
    postcode: "M1 1JW",
    phone: "0161 6378050",
    sourceUrl: "https://travellingman.com/pages/our-shops",
    sourceAttribution: "Travelling Man official stores page",
  }),
  Object.freeze({
    retailerId: "jet-cards",
    providerId: "jet-cards:gaming-centre:SP11-9FT",
    name: "JET Cards Gaming Centre",
    address: "Unit 7D, Brydges Court, Castledown Business Park, Ludgershall, Andover",
    postcode: "SP11 9FT",
    phone: null,
    sourceUrl: "https://jetcards.uk/pages/contact-us",
    sourceAttribution: "JET Cards official contact page",
  }),
  Object.freeze({
    retailerId: "the-card-vault-uk",
    providerId: "the-card-vault-uk:gaming-centre:G2-1HW",
    name: "The Card Vault Gaming Centre",
    address: "Lower Ground Floor, 37 Bath Street, Glasgow",
    postcode: "G2 1HW",
    phone: null,
    sourceUrl: "https://thecardvault.co.uk/pages/the-card-vault-gaming-centre",
    sourceAttribution: "The Card Vault official Gaming Centre page",
  }),
]);

function text(value) {
  return String(value ?? "").trim();
}

function postcodeKey(value) {
  return text(value).replace(/\s+/g, "").toUpperCase();
}

function locationKey(row = {}) {
  const retailerId = text(row.retailerId ?? row.retailer_id);
  const postcode = postcodeKey(row.postcode);
  return retailerId && postcode ? `${retailerId}|${postcode}` : "";
}

async function listExisting(store) {
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

export async function ensureCuratedNetworkRetailerBranchSeeds({
  store,
  seeds = CURATED_NETWORK_RETAILER_BRANCH_SEEDS,
  geocode = geocodeUkPostcode,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Curated network retailer branch seeding requires a store");
  const configured = Array.isArray(seeds) ? seeds : [];
  const existing = await listExisting(store);
  const known = new Set(existing.map(locationKey).filter(Boolean));
  const pending = configured.filter((seed) => !known.has(locationKey(seed)));
  const candidates = [];
  const rejected = [];

  for (const seed of pending) {
    let coordinates = null;
    try {
      coordinates = await geocode(seed.postcode, { fetchImpl });
    } catch (error) {
      rejected.push({ retailerId: seed.retailerId, name: seed.name, postcode: seed.postcode, reason: "geocode_failed", error: String(error?.message || error) });
      continue;
    }
    if (!coordinates || !Number.isFinite(Number(coordinates.latitude)) || !Number.isFinite(Number(coordinates.longitude))) {
      rejected.push({ retailerId: seed.retailerId, name: seed.name, postcode: seed.postcode, reason: "coordinates_missing" });
      continue;
    }

    candidates.push({
      retailerId: seed.retailerId,
      provider: PROVIDER,
      providerId: seed.providerId,
      name: seed.name,
      address: seed.address,
      postcode: seed.postcode,
      latitude: Number(coordinates.latitude),
      longitude: Number(coordinates.longitude),
      websiteUrl: seed.sourceUrl,
      phone: seed.phone || null,
      openingDetails: {
        sourceType: "official_retailer_branch_page",
        sourceUrl: seed.sourceUrl,
        sourceAttribution: seed.sourceAttribution,
        sourceVerifiedAt: VERIFIED_AT,
        provenanceMode: "curated_official_branch_seed",
        stockClaim: "none",
      },
      verification: "official_retailer_branch",
      updatedAt: now,
    });
  }

  const normalized = normalizeRetailerLocationBatch(candidates);
  const persisted = normalized.locations.length
    ? await upsertRetailerLocationsIntoStore(store, normalized.locations)
    : { saved: 0 };

  return {
    status: "ok",
    configured: configured.length,
    alreadyKnown: configured.length - pending.length,
    attempted: pending.length,
    accepted: normalized.locations.length,
    saved: Number(persisted?.saved || 0),
    rejected: [...rejected, ...normalized.rejected],
    truthRule: "Official retailer branch seeds establish canonical store identity only and never imply expected or confirmed stock.",
  };
}
