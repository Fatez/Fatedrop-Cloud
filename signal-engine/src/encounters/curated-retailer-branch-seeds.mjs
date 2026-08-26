import {
  normalizeRetailerLocationBatch,
  upsertRetailerLocationsIntoStore,
} from "./local-stock-store.mjs";
import { geocodeUkPostcode } from "./national-branch-directory-sync.mjs";

const PROVIDER = "entertainer_official_curated_seed";
const RETAILER_ID = "entertainer-uk";
const VERIFIED_AT = "2026-08-26T18:30:00+01:00";

// Narrow bridge for the current real expected-stock proof only.
// Every row was individually checked against The Entertainer's official store pages/index.
// These rows establish branch identity/presence only. They carry no stock claim.
export const CURATED_RETAILER_BRANCH_SEEDS = Object.freeze([
  Object.freeze({ name: "The Entertainer Basildon", address: "91 Eastgate Centre, Basildon", postcode: "SS14 1AF", sourceUrl: "https://www.thetoyshop.com/store/basildon" }),
  Object.freeze({ name: "The Entertainer Basingstoke", address: "16/18 Westminster House, Potters Walk, Basingstoke", postcode: "RG21 7GQ", sourceUrl: "https://www.thetoyshop.com/store/basingstoke" }),
  Object.freeze({ name: "The Entertainer Birmingham - Bullring", address: "Unit MSU10A, Lower Mall Bullring, Birmingham", postcode: "B5 4BE", sourceUrl: "https://www.thetoyshop.com/store/birmingham" }),
  Object.freeze({ name: "The Entertainer Bishops Stortford", address: "18 Jackson Square Shopping Centre, Bishop's Stortford", postcode: "CM23 3XQ", sourceUrl: "https://www.thetoyshop.com/store/bishop-stortford" }),
  Object.freeze({ name: "The Entertainer Bluewater - Greenhithe", address: "Unit U030, Bluewater Shopping Centre, Greenhithe", postcode: "DA9 9ST", sourceUrl: "https://www.thetoyshop.com/store/bluewater" }),
  Object.freeze({ name: "The Entertainer Bracknell", address: "37 Braccan Walk, Bracknell", postcode: "RG12 1BE", sourceUrl: "https://www.thetoyshop.com/store/bracknell" }),
  Object.freeze({ name: "The Entertainer Bromley Lower Mall", address: "The Glades Shopping Centre, Unit 33, Bromley", postcode: "BR1 1DD", sourceUrl: "https://www.thetoyshop.com/store/bromley%20lower%20mall" }),
  Object.freeze({ name: "The Entertainer Crawley", address: "68-69 Upper Mall, County Mall, Crawley", postcode: "RH10 1FP", sourceUrl: "https://www.thetoyshop.com/store/crawley" }),
  Object.freeze({ name: "The Entertainer Lakeside - Grays", address: "Unit 122-123 Level 01, Lakeside Shopping Centre, Grays", postcode: "RM20 2ZP", sourceUrl: "https://www.thetoyshop.com/store/lakeside" }),
  Object.freeze({ name: "The Entertainer Milton Keynes", address: "Centre MK, 152-154 Midsummer Arcade, Milton Keynes", postcode: "MK9 3BA", sourceUrl: "https://www.thetoyshop.com/store/milton-keynes" }),
  Object.freeze({ name: "The Entertainer Stratford - Westfield", address: "SU0060, Westfield Shopping Centre, Stratford", postcode: "E20 1EH", sourceUrl: "https://www.thetoyshop.com/store/stratford" }),
  Object.freeze({ name: "The Entertainer Watford", address: "Harlequin Shopping Centre, INTU Watford, Unit B 83-97 High Street, Watford", postcode: "WD17 2UB", sourceUrl: "https://www.thetoyshop.com/store/watford" }),
  Object.freeze({ name: "The Entertainer Westfield London", address: "Unit 1086, Level 40, Westfield, Ariel Way, London", postcode: "W12 7SL", sourceUrl: "https://www.thetoyshop.com/store/white-city" }),
]);

function postcodeKey(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function retailerId(row = {}) {
  return String(row.retailerId ?? row.retailer_id ?? "");
}

function existingPostcodes(rows = []) {
  return new Set((Array.isArray(rows) ? rows : [])
    .filter((row) => retailerId(row) === RETAILER_ID)
    .map((row) => postcodeKey(row.postcode))
    .filter(Boolean));
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
    WHERE retailer_id=$1
    ORDER BY updated_at DESC
  `, [RETAILER_ID]);
  return rows;
}

export async function ensureCuratedRetailerBranchSeeds({
  store,
  seeds = CURATED_RETAILER_BRANCH_SEEDS,
  geocode = geocodeUkPostcode,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (!store) throw new Error("Curated retailer branch seeding requires a store");
  const configured = Array.isArray(seeds) ? seeds : [];
  const existing = await listExisting(store);
  const knownPostcodes = existingPostcodes(existing);
  const pending = configured.filter((seed) => !knownPostcodes.has(postcodeKey(seed.postcode)));
  const candidates = [];
  const rejected = [];

  for (const seed of pending) {
    let coordinates = null;
    try {
      coordinates = await geocode(seed.postcode, { fetchImpl });
    } catch (error) {
      rejected.push({ name: seed.name, postcode: seed.postcode, reason: "geocode_failed", error: String(error?.message || error) });
      continue;
    }
    if (!coordinates || !Number.isFinite(Number(coordinates.latitude)) || !Number.isFinite(Number(coordinates.longitude))) {
      rejected.push({ name: seed.name, postcode: seed.postcode, reason: "coordinates_missing" });
      continue;
    }
    candidates.push({
      retailerId: RETAILER_ID,
      provider: PROVIDER,
      providerId: seed.sourceUrl,
      name: seed.name,
      address: seed.address,
      postcode: seed.postcode,
      latitude: Number(coordinates.latitude),
      longitude: Number(coordinates.longitude),
      websiteUrl: seed.sourceUrl,
      openingDetails: {
        sourceType: "official_retailer_branch_page",
        sourceUrl: seed.sourceUrl,
        sourceAttribution: "The Entertainer official store directory",
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
    truthRule: "Curated official branch seeds establish canonical store identity only and never imply expected or confirmed stock.",
  };
}
