import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalRadar } from "../src/encounters/local-radar.mjs";

const retailers = [{
  id: "smyths-uk",
  name: "Smyths Toys UK",
  baseUrl: "https://www.smythstoys.com/uk/en-gb/",
}];

const discoveredShop = {
  id: "google:smyths-romford",
  itemType: "shop",
  provider: "google_places",
  providerPlaceId: "smyths-romford",
  name: "Smyths Toys Superstores Romford",
  address: "Romford, RM1 3EE, UK",
  latitude: 51.58,
  longitude: 0.18,
  websiteUrl: "https://www.smythstoys.com/uk/en-gb/",
  localStockStatus: "unknown",
};

const canonicalShop = {
  id: "loc-romford",
  retailerId: "smyths-uk",
  provider: "smyths_official_store_availability",
  providerId: "romford",
  name: "Smyths Toys Superstores Romford",
  address: "Romford, RM1 3EE, UK",
  postcode: "RM1 3EE",
  latitude: 51.58,
  longitude: 0.18,
  storeFormat: "toy_store",
  identityStatus: "canonical",
};

test("official source refresh happens before the Local Radar observation read", async () => {
  const observations = [];
  const store = {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listRetailerLocations() { return [canonicalShop]; },
    async listLocalStockObservations() { return observations; },
    async upsertRetailerLocations(locations) { return { saved: locations.length }; },
  };
  const data = await buildLocalRadar({
    store,
    retailers,
    placesSearch: async () => ({ status: "ok", provider: "google_places", shops: [discoveredShop] }),
    smythsAvailabilityRefresh: async ({ shops }) => {
      assert.equal(shops[0].retailerId, "smyths-uk");
      observations.push({
        id: "evt-smyths-live",
        kind: "echo",
        retailerId: "smyths-uk",
        locationId: "loc-romford",
        locationName: "Smyths Toys Superstores Romford",
        occurredAt: Date.now(),
        productIdentityId: "prd-test-etb",
        productTitle: "Pokemon 30th Celebration Elite Trainer Box",
        evidence: {
          evidenceLevel: "official_collection",
          confidence: 0.99,
          sourceType: "retailer_store_availability",
          sourceUrl: "https://www.smythstoys.com/uk/en-gb/example/p/263924",
          stockStatus: "in_stock",
          availabilityVerified: true,
          physicalEvidenceState: "verified",
        },
      });
      return { provider: "smyths_official_store_availability", status: "ok", productsChecked: 1, observationsSaved: 1, rejected: 0 };
    },
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.providers.smythsLocalStock.status, "ok");
  assert.equal(data.providers.smythsLocalStock.observationsSaved, 1);
  assert.equal(data.providers.localStock.status, "ok");
  assert.equal(data.shops[0].localStockStatus, "in_stock");
  assert.equal(data.shops[0].localStockEvidence.lifecycleState, "echo");
  assert.equal(data.shops[0].localStockEvidence.physicalEvidenceState, "verified");
  assert.equal(data.counts.localInStockBranches, 1);
});

test("official source failure never breaks discovery or invents stock", async () => {
  const store = {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listRetailerLocations() { return [canonicalShop]; },
    async listLocalStockObservations() { return []; },
    async upsertRetailerLocations(locations) { return { saved: locations.length }; },
  };
  const data = await buildLocalRadar({
    store,
    retailers,
    placesSearch: async () => ({ status: "ok", provider: "google_places", shops: [discoveredShop] }),
    smythsAvailabilityRefresh: async () => { throw new Error("source protected"); },
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.providers.smythsLocalStock.status, "unavailable");
  assert.equal(data.shops.length, 1);
  assert.equal(data.shops[0].localStockStatus, "unknown");
  assert.equal(data.counts.localInStockBranches, 0);
});
