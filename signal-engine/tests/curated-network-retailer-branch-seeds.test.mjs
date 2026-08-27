import assert from "node:assert/strict";
import test from "node:test";
import {
  CURATED_NETWORK_RETAILER_BRANCH_SEEDS,
  ensureCuratedNetworkRetailerBranchSeeds,
} from "../src/encounters/curated-network-retailer-branch-seeds.mjs";

test("curated network retailer branches use unique official HTTPS identities", () => {
  assert.equal(CURATED_NETWORK_RETAILER_BRANCH_SEEDS.length, 6);
  const expectedRetailers = new Set(["travelling-man-uk", "jet-cards", "the-card-vault-uk"]);
  const identities = new Set();
  for (const seed of CURATED_NETWORK_RETAILER_BRANCH_SEEDS) {
    assert.equal(expectedRetailers.has(seed.retailerId), true);
    assert.equal(new URL(seed.sourceUrl).protocol, "https:");
    assert.match(seed.sourceAttribution, /official/i);
    const identity = `${seed.retailerId}|${seed.postcode.replace(/\s+/g, "").toUpperCase()}`;
    assert.equal(identities.has(identity), false, `duplicate curated branch identity: ${identity}`);
    identities.add(identity);
  }
});

test("curated network branch seeding persists identity only and never stock evidence", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations(locations) {
      saved.push(...locations);
      return { saved: locations.length };
    },
  };
  const outcome = await ensureCuratedNetworkRetailerBranchSeeds({
    store,
    seeds: [CURATED_NETWORK_RETAILER_BRANCH_SEEDS[4]],
    geocode: async () => ({ latitude: 51.255, longitude: -1.622 }),
    now: 1_788_000_000_000,
  });

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.accepted, 1);
  assert.equal(outcome.saved, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].retailerId, "jet-cards");
  assert.equal(saved[0].verification, "official_retailer_branch");
  assert.equal(saved[0].openingDetails.stockClaim, "none");
  assert.equal(saved[0].openingDetails.provenanceMode, "curated_official_branch_seed");
  assert.equal("stockStatus" in saved[0], false);
  assert.equal("localState" in saved[0], false);
  assert.match(outcome.truthRule, /never imply expected or confirmed stock/i);
});

test("curated network branch seeding does not duplicate a known retailer postcode", async () => {
  let writes = 0;
  const store = {
    async listRetailerLocations() {
      return [{ retailerId: "jet-cards", postcode: "SP11 9FT" }];
    },
    async upsertRetailerLocations() {
      writes += 1;
      return { saved: 0 };
    },
  };
  const outcome = await ensureCuratedNetworkRetailerBranchSeeds({
    store,
    seeds: [CURATED_NETWORK_RETAILER_BRANCH_SEEDS[4]],
    geocode: async () => { throw new Error("known branch must not geocode again"); },
  });

  assert.equal(outcome.alreadyKnown, 1);
  assert.equal(outcome.attempted, 0);
  assert.equal(outcome.saved, 0);
  assert.equal(writes, 0);
});
