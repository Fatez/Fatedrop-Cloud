import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSmythsStorePickupUrl,
  fetchSmythsStoreAvailability,
  normalizeSmythsStockStatus,
  refreshSmythsLocalAvailability,
  smythsBranchKey,
} from "../src/encounters/smyths-local-availability.mjs";

const shop = {
  retailerId: "smyths-uk",
  provider: "google_places",
  providerPlaceId: "google-romford",
  name: "Smyths Toys Superstores Romford",
  address: "Romford, RM1 3EE, UK",
  latitude: 51.58,
  longitude: 0.18,
  websiteUrl: "https://www.smythstoys.com/uk/en-gb/",
};

const mapping = {
  productIdentityId: "prd-test-etb",
  productCode: "263924",
  productTitle: "Pokemon 30th Celebration Elite Trainer Box",
  sourceUrl: "https://www.smythstoys.com/uk/en-gb/example/p/263924",
};

function response(status, body, contentType = "application/json") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

function manifestedStore() {
  let saved = [];
  return {
    saved: () => saved,
    async listVerifiedSmythsProductMappings() { return [mapping]; },
    async upsertLocalStockObservations(observations) {
      saved = observations;
      return { saved: observations.length, duplicates: 0 };
    },
  };
}

test("Smyths branch names use deterministic retailer-specific exact keys", () => {
  assert.equal(smythsBranchKey("Smyths Toys Superstores Romford"), "romford");
  assert.equal(smythsBranchKey("Romford"), "romford");
  assert.notEqual(smythsBranchKey("Romford"), smythsBranchKey("Romford Retail Park"));
});

test("Smyths status parser accepts only explicit stock states", () => {
  assert.equal(normalizeSmythsStockStatus("IN STOCK"), "in_stock");
  assert.equal(normalizeSmythsStockStatus("LOWSTOCK"), "low_stock");
  assert.equal(normalizeSmythsStockStatus("OUTOFSTOCK"), "out_of_stock");
  assert.equal(normalizeSmythsStockStatus("Probably available"), "unknown");
});

test("Smyths request uses the ordinary public store-pickup route", () => {
  const url = new URL(buildSmythsStorePickupUrl({
    productCode: "263924",
    latitude: 51.58,
    longitude: 0.18,
    selectedStore: "romford",
  }));
  assert.equal(url.origin, "https://www.smythstoys.com");
  assert.equal(url.pathname, "/api/uk/en-gb/store-pickup/pointOfServices");
  assert.equal(url.searchParams.get("productId"), "263924");
  assert.equal(url.searchParams.get("selectedStore"), "romford");
  assert.equal(url.searchParams.get("searchThroughGeoPointFirst"), "true");
});

test("Smyths source fails closed when the ordinary request is protected", async () => {
  let calls = 0;
  const result = await fetchSmythsStoreAvailability({
    productCode: "263924",
    latitude: 51.58,
    longitude: 0.18,
    fetchImpl: async () => {
      calls += 1;
      return response(403, "<html>challenge</html>", "text/html");
    },
  });
  assert.equal(calls, 1, "protected sources must not be retried or bypassed");
  assert.equal(result.status, "protected");
  assert.deepEqual(result.stores, []);
});

test("verified Smyths mapping plus exact official branch availability can create Manifested", async () => {
  const store = manifestedStore();
  const result = await refreshSmythsLocalAvailability({
    store,
    shops: [shop],
    latitude: 51.58,
    longitude: 0.18,
    minRefreshMs: 0,
    fetchImpl: async () => response(200, JSON.stringify({
      stores: [{ name: "Romford", postalCode: "RM1 3EE", stockLevelStatusCode: "INSTOCK", id: "romford" }],
    })),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.observationsSaved, 1);
  assert.equal(store.saved().length, 1);
  assert.equal(store.saved()[0].kind, "manifested");
  assert.equal(store.saved()[0].productIdentityId, "prd-test-etb");
  assert.equal(store.saved()[0].evidence.evidenceLevel, "official_collection");
  assert.equal(store.saved()[0].evidence.availabilityVerified, true);
  assert.equal(store.saved()[0].evidence.stockStatus, "in_stock");
});

test("official Smyths response can establish an exact canonical branch without Google Places", async () => {
  let locations = [];
  let observations = [];
  const store = {
    async listVerifiedSmythsProductMappings() { return [mapping]; },
    async upsertRetailerLocations(rows) {
      locations = rows;
      return { saved: rows.length };
    },
    async upsertLocalStockObservations(rows) {
      observations = rows;
      return { saved: rows.length, duplicates: 0 };
    },
  };
  const result = await refreshSmythsLocalAvailability({
    store,
    shops: [],
    latitude: 51.58,
    longitude: 0.18,
    minRefreshMs: 0,
    fetchImpl: async () => response(200, JSON.stringify({
      stores: [{
        id: "romford-pos-001",
        name: "Romford",
        postalCode: "RM1 3EE",
        geoPoint: { latitude: 51.58, longitude: 0.18 },
        stockLevelStatusCode: "INSTOCK",
      }],
    })),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.branchesDiscovered, 1);
  assert.equal(result.branchesPersisted, 1);
  assert.equal(locations.length, 1);
  assert.equal(locations[0].provider, "smyths_official_store_availability");
  assert.equal(locations[0].providerId, "romford-pos-001");
  assert.equal(locations[0].verification, "official_retailer_branch");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].locationId, locations[0].id);
  assert.equal(observations[0].kind, "manifested");
  assert.equal(observations[0].evidence.branchIdentitySource, "smyths_official_store_availability");
});

test("official store result without an exact official identity and coordinates does not bootstrap a branch", async () => {
  let locations = [];
  let observations = [];
  const store = {
    async listVerifiedSmythsProductMappings() { return [mapping]; },
    async upsertRetailerLocations(rows) {
      locations = rows;
      return { saved: rows.length };
    },
    async upsertLocalStockObservations(rows) {
      observations = rows;
      return { saved: rows.length, duplicates: 0 };
    },
  };
  const result = await refreshSmythsLocalAvailability({
    store,
    shops: [],
    latitude: 51.58,
    longitude: 0.18,
    minRefreshMs: 0,
    fetchImpl: async () => response(200, JSON.stringify({
      stores: [{ name: "Somewhere", stockLevelStatusCode: "INSTOCK" }],
    })),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.branchesDiscovered, 0);
  assert.deepEqual(locations, []);
  assert.deepEqual(observations, []);
});

test("official store result for a different branch is not attached fuzzily", async () => {
  const store = manifestedStore();
  const result = await refreshSmythsLocalAvailability({
    store,
    shops: [shop],
    latitude: 51.58,
    longitude: 0.18,
    minRefreshMs: 0,
    fetchImpl: async () => response(200, JSON.stringify({
      stores: [{ name: "Romford Retail Park", stockLevelStatusCode: "INSTOCK", id: "other-romford" }],
    })),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.observationsSaved, 0);
  assert.deepEqual(store.saved(), []);
});

test("out-of-stock cannot create an orphan Vanished through the Smyths source", async () => {
  let persisted = [];
  const store = {
    async listVerifiedSmythsProductMappings() { return [mapping]; },
    async hasPriorLocalManifested() { return false; },
    async upsertLocalStockObservations(observations) {
      persisted = observations;
      return { saved: observations.length };
    },
  };
  const result = await refreshSmythsLocalAvailability({
    store,
    shops: [shop],
    latitude: 51.58,
    longitude: 0.18,
    minRefreshMs: 0,
    fetchImpl: async () => response(200, JSON.stringify({
      stores: [{ name: "Romford", postalCode: "RM1 3EE", stockLevelStatusCode: "OUTOFSTOCK", id: "romford" }],
    })),
  });
  assert.equal(result.observationsSaved, 0);
  assert.equal(result.rejected, 1);
  assert.deepEqual(persisted, []);
});
