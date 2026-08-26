import assert from "node:assert/strict";
import test from "node:test";

import { runAsdaBranchDensitySync } from "../src/encounters/asda-branch-density-sync.mjs";

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

function parsedLocation(url, index) {
  return {
    location: {
      retailerId: "asda-uk",
      provider: "asda_official_directory",
      providerId: url,
      name: `ASDA Test ${index}`,
      address: `${index} High Street`,
      postcode: `AA${index} ${index}AA`,
      latitude: 51 + index / 100,
      longitude: -0.1 - index / 100,
      websiteUrl: url,
      verification: "official_retailer_branch",
      openingDetails: { discoveryProvider: "test" },
      updatedAt: Date.now(),
    },
    reason: null,
  };
}

test("ASDA density sync skips known branches, persists new branches, and keeps stock unknown", async () => {
  const knownUrl = "https://storelocator.asda.com/east/test/existing";
  const newUrl = "https://storelocator.asda.com/east/test/new";
  const rejectedUrl = "https://storelocator.asda.com/east/test/petrol";
  const store = createStore([{
    retailerId: "asda-uk",
    provider: "asda_official_directory",
    providerId: knownUrl,
  }]);
  const parsed = [];

  const outcome = await runAsdaBranchDensitySync({
    store,
    concurrency: 4,
    discoverFn: async () => [
      { url: knownUrl, retailerId: "asda-uk", provider: "asda_official_directory" },
      { url: newUrl, retailerId: "asda-uk", provider: "asda_official_directory" },
      { url: rejectedUrl, retailerId: "asda-uk", provider: "asda_official_directory" },
    ],
    parseFn: async (row) => {
      parsed.push(row.url);
      if (row.url === rejectedUrl) return { location: null, reason: "asda_non_tcg_store_format" };
      return parsedLocation(row.url, 1);
    },
  });

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.discovered, 3);
  assert.equal(outcome.alreadyKnown, 1);
  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.accepted, 1);
  assert.equal(outcome.saved, 1);
  assert.equal(outcome.rejected, 1);
  assert.deepEqual(parsed.sort(), [newUrl, rejectedUrl].sort());
  assert.equal(store.saved.length, 1);
  const [location] = store.saved;
  assert.equal(location.retailerId, "asda-uk");
  assert.equal(location.provider, "asda_official_directory");
  assert.equal(location.openingDetails.sourceAttribution, "ASDA official store locator");
  assert.equal(location.openingDetails.stockStatus, "unknown");
  assert.equal(location.openingDetails.stockClaim, false);
});

test("ASDA density sync fails closed when official discovery is unavailable", async () => {
  const store = createStore();
  const outcome = await runAsdaBranchDensitySync({
    store,
    discoverFn: async () => { throw new Error("source blocked"); },
  });

  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.saved, 0);
  assert.equal(outcome.attempted, 0);
  assert.match(outcome.error, /source blocked/);
  assert.equal(store.saved.length, 0);
});

test("ASDA density sync bounds requested concurrency", async () => {
  const store = createStore();
  const outcome = await runAsdaBranchDensitySync({
    store,
    concurrency: 99,
    discoverFn: async () => [],
  });
  assert.equal(outcome.concurrency, 12);
});
