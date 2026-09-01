import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalRadar } from "../src/encounters/local-radar.mjs";

const retailers = [{ id: "tesco-uk", name: "Tesco", baseUrl: "https://www.tesco.com/" }];

async function placesSearch() {
  return {
    status: "ok",
    provider: "test_places",
    shops: [{
      id: "tesco-cheshunt-place",
      itemType: "shop",
      provider: "google_places",
      providerPlaceId: "tesco-cheshunt-place",
      name: "Tesco Cheshunt",
      address: "Cheshunt",
      latitude: 51.70,
      longitude: -0.03,
      websiteUrl: "https://www.tesco.com/",
      localStockStatus: "unknown",
    }],
  };
}

function storeWith(observation) {
  return {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listRetailerLocations() {
      return [{
        id: "tesco-cheshunt",
        retailerId: "tesco-uk",
        provider: "tesco_store",
        providerId: "cheshunt",
        name: "Tesco Cheshunt",
        address: "Cheshunt",
        postcode: "EN8 9XQ",
        latitude: 51.70,
        longitude: -0.03,
        storeFormat: "supermarket",
        identityStatus: "canonical",
      }];
    },
    async listLocalStockObservations() { return [observation]; },
  };
}

function manifested(overrides = {}) {
  return {
    id: "tesco-local-value",
    kind: "manifested",
    retailerId: "tesco-uk",
    locationId: "tesco-cheshunt",
    locationName: "Tesco Cheshunt",
    occurredAt: Date.now(),
    productIdentityId: "pokemon:destined-rivals-etb",
    productTitle: "Destined Rivals Elite Trainer Box",
    evidence: {
      evidenceLevel: "official_branch",
      sourceType: "retailer_store_availability",
      confidence: 0.99,
      stockStatus: "in_stock",
      availabilityVerified: true,
      itemPricePence: 4999,
    },
    ...overrides,
  };
}

async function radarFor(observation) {
  return buildLocalRadar({
    store: storeWith(observation),
    retailers,
    placesSearch,
    latitude: 51.70,
    longitude: -0.03,
    radiusMiles: 10,
    types: ["shops"],
  });
}

test("Local Radar reuses canonical RRP intelligence for physical item value", async () => {
  const data = await radarFor(manifested({
    officialRrpPence: 4999,
    rrpSource: "pokemon_official",
    rrpObservedAt: Date.now() - 60_000,
  }));
  const value = data.shops[0].localStockProducts[0].value;
  assert.equal(value.priceKnown, true);
  assert.equal(value.itemPricePence, 4999);
  assert.equal(value.rrp.known, true);
  assert.equal(value.rrp.pence, 4999);
  assert.equal(value.rrp.source, "pokemon_official");
  assert.equal(value.itemVsRrp.deltaPence, 0);
  assert.equal(value.itemVsRrp.deltaPercent, 0);
  assert.equal(value.itemVsRrp.aboveRrp, false);
});

test("unknown canonical RRP stays unknown even when a local selling price is known", async () => {
  const data = await radarFor(manifested({
    officialRrpPence: null,
    rrpSource: null,
    rrpObservedAt: null,
  }));
  const value = data.shops[0].localStockProducts[0].value;
  assert.equal(value.priceKnown, true);
  assert.equal(value.itemPricePence, 4999);
  assert.equal(value.rrp.known, false);
  assert.equal(value.rrp.pence, null);
  assert.equal(value.itemVsRrp.deltaPence, null);
  assert.equal(value.itemVsRrp.deltaPercent, null);
});

test("zero-price preparation sentinels are not accepted as commercial local price truth", async () => {
  const observation = manifested({
    officialRrpPence: 4999,
    rrpSource: "pokemon_official",
    evidence: {
      evidenceLevel: "official_branch",
      sourceType: "retailer_store_availability",
      confidence: 0.99,
      stockStatus: "in_stock",
      availabilityVerified: true,
      itemPricePence: 0,
    },
  });
  const data = await radarFor(observation);
  const value = data.shops[0].localStockProducts[0].value;
  assert.equal(value.priceKnown, false);
  assert.equal(value.itemPricePence, null);
  assert.equal(value.priceQuality, "placeholder");
  assert.equal(value.rrp.known, true);
  assert.equal(value.itemVsRrp.deltaPence, null);
});
