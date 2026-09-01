import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalRadar } from "../src/encounters/local-radar.mjs";
import { persistMatchedRetailerLocations } from "../src/encounters/local-radar-branch-persistence.mjs";

const retailers = [{
  id: "smyths-uk",
  name: "Smyths Toys UK",
  baseUrl: "https://www.smythstoys.com/uk/en-gb/",
}];

const smythsPlace = {
  id: "google:smyths-romford",
  itemType: "shop",
  provider: "google_places",
  providerPlaceId: "smyths-romford",
  name: "Smyths Toys Superstores Romford",
  address: "Romford, UK",
  latitude: 51.58,
  longitude: 0.18,
  websiteUrl: "https://www.smythstoys.com/uk/en-gb/",
  localStockStatus: "unknown",
};

test("persists an exact matched connected branch with stable provider identity", async () => {
  let saved = [];
  const store = {
    async upsertRetailerLocations(locations) {
      saved = locations;
      return { saved: locations.length };
    },
  };
  const result = await persistMatchedRetailerLocations(store, [{ ...smythsPlace, retailerId: "smyths-uk" }]);
  assert.equal(result.status, "ok");
  assert.equal(result.saved, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].retailerId, "smyths-uk");
  assert.equal(saved[0].provider, "google_places");
  assert.equal(saved[0].providerId, "smyths-romford");
  assert.equal(saved[0].verification, "provider_discovered");
  assert.equal(saved[0].identityStatus, "provisional");
  assert.equal(saved[0].tcgSellerStatus, "likely");
  assert.equal(saved[0].openingDetails.stockClaim, false);
  assert.match(saved[0].id, /^loc_/);
});

test("matched pharmacy and fuel service results are rejected before branch persistence", async () => {
  let saved = [];
  const store = {
    async upsertRetailerLocations(locations) {
      saved = locations;
      return { saved: locations.length };
    },
  };
  const serviceRows = [
    { ...smythsPlace, retailerId: "tesco-uk", providerPlaceId: "tesco-fuel", name: "Tesco Fuel Express" },
    { ...smythsPlace, retailerId: "tesco-uk", providerPlaceId: "tesco-pharmacy", name: "Tesco Watford Pharmacy" },
  ];
  const result = await persistMatchedRetailerLocations(store, serviceRows);
  assert.equal(result.status, "empty");
  assert.equal(result.saved, 0);
  assert.equal(result.received, 2);
  assert.equal(result.rejected.length, 2);
  assert.equal(saved.length, 0);
  assert.ok(result.rejected.every((row) => String(row.reason).startsWith("service_location:")));
});

test("does not persist unmatched discovery-only shops", async () => {
  let called = false;
  const store = {
    async upsertRetailerLocations() {
      called = true;
      return { saved: 1 };
    },
  };
  const result = await persistMatchedRetailerLocations(store, [{ ...smythsPlace, retailerId: null }]);
  assert.equal(result.status, "empty");
  assert.equal(result.saved, 0);
  assert.equal(called, false);
});

test("Local Radar persists exact chain matches but keeps stock truth unknown", async () => {
  let saved = [];
  const store = {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listLocalStockObservations() { return []; },
    async upsertRetailerLocations(locations) {
      saved = locations;
      return { saved: locations.length };
    },
  };
  const data = await buildLocalRadar({
    store,
    retailers,
    placesSearch: async () => ({ status: "ok", provider: "google_places", shops: [smythsPlace] }),
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].retailerId, "smyths-uk");
  assert.equal(data.providers.branchIdentity.status, "ok");
  assert.equal(data.providers.branchIdentity.saved, 1);
  assert.equal(data.contractVersion, 2);
  assert.equal(data.mapPolicy.markerBudget, 72);
  assert.deepEqual(data.filters.retailerGroups, ["supermarkets", "large_retailers", "independents", "unclassified"]);
  assert.equal(saved[0].identityStatus, "provisional");
  assert.equal(saved[0].openingDetails.stockStatus, "unknown");
  assert.equal(data.shops.length, 0, "provisional live-provider matches stay off the public map until canonical");
});

test("branch persistence failure is observable but never turns discovery into false stock", async () => {
  const store = {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listLocalStockObservations() { return []; },
    async upsertRetailerLocations() { throw new Error("database unavailable"); },
  };
  const data = await buildLocalRadar({
    store,
    retailers,
    placesSearch: async () => ({ status: "ok", provider: "google_places", shops: [smythsPlace] }),
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });
  assert.equal(data.providers.branchIdentity.status, "unavailable");
  assert.equal(data.providers.branchIdentity.saved, 0);
  assert.equal(data.shops.length, 0, "failed provisional persistence cannot leak a discovery candidate onto the public map");
});
