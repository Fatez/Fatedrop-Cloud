import assert from "node:assert/strict";
import test from "node:test";

import {
  CURATED_RETAILER_BRANCH_SEEDS,
  ensureCuratedRetailerBranchSeeds,
} from "../src/encounters/curated-retailer-branch-seeds.mjs";

const SEED = CURATED_RETAILER_BRANCH_SEEDS.find((row) => row.name === "The Entertainer Watford");

test("curated official branch seed establishes identity only and carries no stock state", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations(rows) { saved.push(...rows); return { saved: rows.length }; },
  };
  const result = await ensureCuratedRetailerBranchSeeds({
    store,
    seeds: [SEED],
    geocode: async () => ({ latitude: 51.6565, longitude: -0.3971 }),
    now: Date.parse("2026-08-26T18:45:00+01:00"),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.saved, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].retailerId, "entertainer-uk");
  assert.equal(saved[0].provider, "entertainer_official_curated_seed");
  assert.equal(saved[0].providerId, "https://www.thetoyshop.com/store/watford");
  assert.equal(saved[0].name, "The Entertainer Watford");
  assert.equal(saved[0].postcode, "WD17 2UB");
  assert.equal(saved[0].verification, "official_retailer_branch");
  assert.equal(saved[0].openingDetails.stockClaim, "none");
  assert.equal("stockStatus" in saved[0], false);
  assert.equal("availabilityVerified" in saved[0], false);
});

test("existing canonical retailer branch postcode is not duplicated across providers", async () => {
  let geocodes = 0;
  let writes = 0;
  const store = {
    async listRetailerLocations() {
      return [{ retailerId: "entertainer-uk", provider: "google_places", postcode: "WD17 2UB" }];
    },
    async upsertRetailerLocations() { writes += 1; return { saved: 0 }; },
  };
  const result = await ensureCuratedRetailerBranchSeeds({
    store,
    seeds: [SEED],
    geocode: async () => { geocodes += 1; return { latitude: 1, longitude: 1 }; },
  });
  assert.equal(result.alreadyKnown, 1);
  assert.equal(result.attempted, 0);
  assert.equal(result.saved, 0);
  assert.equal(geocodes, 0);
  assert.equal(writes, 0);
});

test("missing postcode coordinates fail closed and persist no branch", async () => {
  let writes = 0;
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations() { writes += 1; return { saved: 0 }; },
  };
  const result = await ensureCuratedRetailerBranchSeeds({
    store,
    seeds: [SEED],
    geocode: async () => null,
  });
  assert.equal(result.saved, 0);
  assert.equal(result.accepted, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "coordinates_missing");
  assert.equal(writes, 0);
});

test("seed provider identity is stable and official source URL is retained", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations(rows) { saved.push(...rows); return { saved: rows.length }; },
  };
  await ensureCuratedRetailerBranchSeeds({
    store,
    seeds: [SEED],
    geocode: async () => ({ latitude: 51.6565, longitude: -0.3971 }),
  });
  assert.match(saved[0].id, /^loc_/);
  assert.equal(saved[0].website, SEED.sourceUrl);
  assert.equal(saved[0].openingDetails.sourceUrl, SEED.sourceUrl);
  assert.equal(saved[0].openingDetails.sourceType, "official_retailer_branch_page");
  assert.equal(saved[0].openingDetails.provenanceMode, "curated_official_branch_seed");
});

test("current bridge is deliberately bounded to the thirteen stores named by the live expected-stock notice", () => {
  assert.equal(CURATED_RETAILER_BRANCH_SEEDS.length, 13);
  assert.deepEqual(
    CURATED_RETAILER_BRANCH_SEEDS.map((row) => row.name),
    [
      "The Entertainer Basildon",
      "The Entertainer Basingstoke",
      "The Entertainer Birmingham - Bullring",
      "The Entertainer Bishops Stortford",
      "The Entertainer Bluewater - Greenhithe",
      "The Entertainer Bracknell",
      "The Entertainer Bromley Lower Mall",
      "The Entertainer Crawley",
      "The Entertainer Lakeside - Grays",
      "The Entertainer Milton Keynes",
      "The Entertainer Stratford - Westfield",
      "The Entertainer Watford",
      "The Entertainer Westfield London",
    ],
  );
});
