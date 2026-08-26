import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalRadar } from "../src/encounters/local-radar.mjs";

const retailers = [
  {
    id: "smyths-uk",
    name: "Smyths Toys UK",
    baseUrl: "https://www.smythstoys.com/uk/en-gb/",
  },
];

function placesSearch() {
  return Promise.resolve({
    status: "ok",
    provider: "test_places",
    shops: [
      {
        id: "place-smyths-romford",
        itemType: "shop",
        provider: "google_places",
        providerPlaceId: "smyths-romford",
        name: "Smyths Toys Superstores Romford",
        address: "Romford",
        latitude: 51.58,
        longitude: 0.18,
        websiteUrl: null,
        localStockStatus: "unknown",
      },
    ],
  });
}

function storeWith(observations) {
  return {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listLocalStockObservations() { return observations; },
  };
}

test("official branch evidence can produce verified local in-stock", async () => {
  const now = Date.now();
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-official",
      kind: "local_in_stock",
      retailerId: "smyths-uk",
      locationId: "loc-romford",
      locationName: "Smyths Toys Superstores Romford",
      occurredAt: now,
      productIdentityId: "pokemon:test-etb",
      productTitle: "Test Elite Trainer Box",
      evidence: {
        evidenceLevel: "official_branch",
        confidence: 0.99,
        sourceType: "retailer_store_availability",
        sourceUrl: "https://www.smythstoys.com/uk/en-gb/",
      },
    }]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops.length, 1);
  assert.equal(data.shops[0].retailerId, "smyths-uk", "national-chain aliases should resolve to the canonical retailer");
  assert.equal(data.shops[0].localStockStatus, "in_stock");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, true);
  assert.equal(data.shops[0].localStockProducts[0].title, "Test Elite Trainer Box");
  assert.equal(data.counts.localInStockBranches, 1);
  assert.equal(data.counts.incomingWatchBranches, 0);
});

test("community evidence is downgraded to incoming watch instead of fake branch stock", async () => {
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-community",
      kind: "local_in_stock",
      retailerId: "smyths-uk",
      locationId: "loc-romford",
      locationName: "Smyths Toys Superstores Romford",
      occurredAt: Date.now(),
      productIdentityId: "pokemon:test-etb",
      productTitle: "Test Elite Trainer Box",
      evidence: {
        evidenceLevel: "community_report",
        confidence: 0.72,
        sourceType: "community_sighting",
      },
    }]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops[0].localStockStatus, "incoming_watch");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, false);
  assert.equal(data.counts.localInStockBranches, 0);
  assert.equal(data.counts.incomingWatchBranches, 1);
});

test("stale physical stock expires instead of lingering as current stock", async () => {
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-stale",
      kind: "local_in_stock",
      retailerId: "smyths-uk",
      locationId: "loc-romford",
      locationName: "Smyths Toys Superstores Romford",
      occurredAt: sixHoursAgo,
      productIdentityId: "pokemon:test-etb",
      productTitle: "Test Elite Trainer Box",
      evidence: {
        evidenceLevel: "official_branch",
        confidence: 0.99,
        sourceType: "retailer_store_availability",
      },
    }]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops[0].localStockStatus, "unknown");
  assert.equal(data.shops[0].localStockEvidence, null);
  assert.deepEqual(data.shops[0].localStockProducts, []);
  assert.equal(data.counts.localInStockBranches, 0);
});

test("preparation evidence remains an incoming watch and never becomes manifested by naming alone", async () => {
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-incoming",
      kind: "local_incoming",
      retailerId: "smyths-uk",
      locationId: "loc-romford",
      locationName: "Smyths Toys Superstores Romford",
      occurredAt: Date.now(),
      productIdentityId: "pokemon:test-etb",
      productTitle: "Test Elite Trainer Box",
      evidence: {
        evidenceLevel: "official_branch",
        confidence: 0.8,
        sourceType: "inventory_preparation",
      },
    }]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops[0].localStockStatus, "incoming_watch");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, false);
});
