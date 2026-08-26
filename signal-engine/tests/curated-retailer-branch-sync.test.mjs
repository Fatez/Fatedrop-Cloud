import assert from "node:assert/strict";
import test from "node:test";

import { runCuratedRetailerBranchSync } from "../src/encounters/curated-retailer-branch-sync.mjs";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function createStore() {
  const saved = [];
  return {
    saved,
    async upsertRetailerLocations(locations) {
      saved.push(...locations);
      return { saved: locations.length, inserted: locations.length, updated: 0 };
    },
  };
}

test("curated branch seed with exact coordinates establishes a branch but never claims stock", async () => {
  const store = createStore();
  const outcome = await runCuratedRetailerBranchSync({
    store,
    now: Date.parse("2026-08-26T18:00:00Z"),
    seeds: [{
      retailerId: "smyths-uk",
      branchName: "Smyths Toys — Watford",
      branchKey: "watford",
      address: "Century Retail Park, Watford",
      postcode: "WD17 2SF",
      latitude: 51.657,
      longitude: -0.395,
      website: "https://www.smythstoys.com/uk/en-gb/storefinder/storedetails/watford",
      sourceType: "official_retailer_directory_snapshot",
      verification: "official_retailer_branch",
    }],
  });

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.accepted, 1);
  assert.equal(store.saved.length, 1);
  const [location] = store.saved;
  assert.equal(location.retailerId, "smyths-uk");
  assert.equal(location.provider, "fatedrop_curated_branch");
  assert.equal(location.providerId, "watford");
  assert.equal(location.verification, "official_retailer_branch");
  assert.equal(location.openingDetails.physicalRetailer, true);
  assert.deepEqual(location.openingDetails.supportedTcgs, ["pokemon"]);
  assert.equal(location.openingDetails.stockStatus, "unknown");
  assert.equal(location.openingDetails.stockClaim, false);
});

test("curated branch seed can geocode a postcode without inventing stock state", async () => {
  const store = createStore();
  const fetchImpl = async (url) => {
    assert.match(String(url), /postcodes\.io\/postcodes\/DL5%206BF/);
    return jsonResponse({ result: { latitude: 54.6205, longitude: -1.5581 } });
  };
  const outcome = await runCuratedRetailerBranchSync({
    store,
    fetchImpl,
    seeds: [{
      retailerId: "total-cards",
      branchName: "Total Cards Gaming Centre",
      postcode: "DL5 6BF",
      sourceType: "manual_verified_branch",
    }],
  });

  assert.equal(outcome.accepted, 1);
  assert.equal(store.saved[0].latitude, 54.6205);
  assert.equal(store.saved[0].longitude, -1.5581);
  assert.equal(store.saved[0].openingDetails.coordinateSource, "postcodes.io");
  assert.equal(store.saved[0].openingDetails.stockStatus, "unknown");
});

test("curated branch seed fails closed when it cannot be placed on the map", async () => {
  const store = createStore();
  const outcome = await runCuratedRetailerBranchSync({
    store,
    seeds: [{ retailerId: "smyths-uk", branchName: "Smyths Toys — Unknown" }],
  });

  assert.equal(outcome.status, "empty");
  assert.equal(outcome.accepted, 0);
  assert.equal(store.saved.length, 0);
  assert.match(outcome.rejected[0].reason, /coordinates or a geocodable postcode/);
});
