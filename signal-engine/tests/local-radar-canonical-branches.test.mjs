import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalRadar } from "../src/encounters/local-radar.mjs";
import {
  listCanonicalRetailerLocationShops,
  mergeCanonicalRetailerShops,
} from "../src/encounters/canonical-retailer-locations.mjs";

const smythsBranch = {
  id: "loc_smyths_stevenage",
  retailerId: "smyths-uk",
  provider: "official_retailer_directory",
  providerId: "stevenage",
  name: "Smyths Toys Stevenage",
  address: "Unit 6 Roaring Meg Retail Park, Great North Road, Stevenage",
  postcode: "SG1 1XN",
  latitude: 51.9016,
  longitude: -0.2106,
  verification: "official_retailer_branch",
  updatedAt: Math.floor(Date.now() / 1000),
};

test("canonical persisted branch remains visible when Places is unconfigured", async () => {
  const store = {
    async listRetailerLocations() { return [smythsBranch]; },
    async listOffers() { return []; },
    async listLocalStockObservations() { return []; },
  };
  const result = await buildLocalRadar({
    store,
    retailers: [{ id: "smyths-uk", name: "Smyths Toys", baseUrl: "https://www.smythstoys.com" }],
    placesSearch: async () => ({ provider: "google_places", status: "unconfigured", shops: [] }),
    smythsAvailabilityRefresh: async () => ({
      provider: "smyths_official_store_availability",
      status: "cooldown",
      productsChecked: 0,
      observationsSaved: 0,
      rejected: 0,
    }),
    latitude: 51.9016,
    longitude: -0.2106,
    radiusMiles: 10,
    tcg: "pokemon",
    types: ["shops"],
  });

  assert.equal(result.providers.shops.status, "unconfigured");
  assert.equal(result.providers.branchIdentity.status, "ok");
  assert.equal(result.providers.branchIdentity.known, 1);
  assert.equal(result.shops.length, 1);
  assert.equal(result.shops[0].id, smythsBranch.id);
  assert.equal(result.shops[0].retailerId, "smyths-uk");
  assert.equal(result.shops[0].verificationStatus, "official_retailer_branch");
  assert.equal(result.shops[0].localStockStatus, "unknown");
  assert.notEqual(result.shops[0].localStockStatus, "in_stock");
});

test("canonical branch reader respects radius and does not return the national registry", async () => {
  const store = {
    async listRetailerLocations() {
      return [
        smythsBranch,
        { ...smythsBranch, id: "loc_far", providerId: "bury", name: "Smyths Toys Bury", postcode: "BL9 7AZ", latitude: 53.5933, longitude: -2.2966 },
      ];
    },
  };
  const result = await listCanonicalRetailerLocationShops(store, {
    origin: { latitude: 51.9016, longitude: -0.2106 },
    radiusMiles: 10,
  });
  assert.equal(result.totalKnown, 2);
  assert.equal(result.shops.length, 1);
  assert.equal(result.shops[0].id, smythsBranch.id);
});

test("fresh discovery and canonical identity for the same branch render once with canonical id", () => {
  const discovered = [{
    id: "google:abc",
    itemType: "shop",
    provider: "google_places",
    providerPlaceId: "abc",
    name: "Smyths Toys Stevenage",
    latitude: 51.90161,
    longitude: -0.21061,
    retailerId: "smyths-uk",
    businessStatus: "operational",
    sourceAttribution: "Google Places",
    stockEvidence: "online_catalogue_only",
  }];
  const canonical = [{
    ...smythsBranch,
    itemType: "shop",
    providerPlaceId: smythsBranch.providerId,
    verificationStatus: "official_retailer_branch",
    discoveryScope: "canonical-branch",
    networkStatus: "live_connected",
    localStockStatus: "unknown",
    stockEvidence: "none",
    sourceAttribution: "FateDrop canonical retailer branch registry",
  }];
  const merged = mergeCanonicalRetailerShops(discovered, canonical);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, smythsBranch.id);
  assert.equal(merged[0].businessStatus, "operational");
});
