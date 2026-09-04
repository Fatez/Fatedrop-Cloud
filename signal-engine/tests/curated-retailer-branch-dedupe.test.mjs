import assert from "node:assert/strict";
import test from "node:test";

import { runCuratedRetailerBranchSync } from "../src/encounters/curated-retailer-branch-sync.mjs";

function createStore(existing = []) {
  const saved = [];
  return {
    saved,
    async listRetailerLocations() { return existing; },
    async upsertRetailerLocations(locations) {
      saved.push(...locations);
      return { saved: locations.length, inserted: locations.length, updated: 0 };
    },
  };
}

test("curated import skips a branch already known from another provider and collapses duplicate seeds", async () => {
  const store = createStore([{
    id: "existing-smyths-enfield",
    retailerId: "smyths-uk",
    provider: "openstreetmap",
    providerId: "way/123",
    name: "Smyths Toys Enfield",
    postcode: "EN1 3RW",
    latitude: 51.65,
    longitude: -0.05,
  }]);

  const fresh = {
    retailerId: "smyths-uk",
    branchName: "Smyths Toys — Croydon",
    branchKey: "smyths-uk:cr04xj",
    postcode: "CR0 4XJ",
    latitude: 51.36,
    longitude: -0.12,
    sourceType: "fatedrop_curated_branch_database",
  };
  const outcome = await runCuratedRetailerBranchSync({
    store,
    registrySeeds: [],
    seeds: [{
      retailerId: "smyths-uk",
      branchName: "Smyths Toys — Enfield",
      branchKey: "smyths-uk:en13rw",
      postcode: "EN1 3RW",
      latitude: 51.65,
      longitude: -0.05,
    }, fresh, { ...fresh }],
  });

  assert.equal(outcome.configured, 3);
  assert.equal(outcome.alreadyKnown, 1);
  assert.equal(outcome.duplicateSeeds, 1);
  assert.equal(outcome.accepted, 1);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].postcode, "CR0 4XJ");
  assert.equal(store.saved[0].openingDetails.stockStatus, "unknown");
  assert.equal(store.saved[0].openingDetails.stockClaim, false);
});

test("same postcode is preserved when it belongs to different retailers", async () => {
  const store = createStore();
  const seeds = [
    { retailerId: "smyths-uk", branchName: "Smyths Toys — Team Valley", postcode: "NE11 0BD", latitude: 54.93, longitude: -1.62 },
    { retailerId: "asda-uk", branchName: "ASDA — Gateshead Supercentre", postcode: "NE11 0BD", latitude: 54.931, longitude: -1.621 },
    { retailerId: "bm-stores-uk", branchName: "B&M — Newcastle Team Valley", postcode: "NE11 0BD", latitude: 54.932, longitude: -1.622 },
  ];
  const outcome = await runCuratedRetailerBranchSync({ store, registrySeeds: [], seeds });

  assert.equal(outcome.accepted, 3);
  assert.equal(outcome.duplicateSeeds, 0);
  assert.equal(store.saved.length, 3);
  assert.deepEqual(new Set(store.saved.map((row) => row.retailerId)), new Set(["smyths-uk", "asda-uk", "bm-stores-uk"]));
});
