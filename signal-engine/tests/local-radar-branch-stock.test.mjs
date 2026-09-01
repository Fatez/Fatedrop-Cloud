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
    async listRetailerLocations() {
      return [{
        id: "loc-romford",
        retailerId: "smyths-uk",
        provider: "smyths_official_store_availability",
        providerId: "romford",
        name: "Smyths Toys Superstores Romford",
        address: "Romford",
        postcode: "RM1 3EE",
        latitude: 51.58,
        longitude: 0.18,
        storeFormat: "toy_store",
        identityStatus: "canonical",
      }];
    },
    async listLocalStockObservations() { return observations; },
  };
}

test("legacy physical Manifested evidence projects as verified Echo in-store stock", async () => {
  const now = Date.now();
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-official",
      kind: "manifested",
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
        stockStatus: "in_stock",
        availabilityVerified: true,
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
  assert.equal(data.shops[0].localStockEvidence.lifecycleState, "echo");
  assert.equal(data.shops[0].localStockEvidence.physicalEvidenceState, "verified");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, true);
  assert.equal(data.shops[0].localStockProducts[0].title, "Test Elite Trainer Box");
  assert.equal(data.counts.localInStockBranches, 1);
  assert.equal(data.counts.incomingWatchBranches, 0);
});

test("community evidence cannot create verified Manifested branch stock", async () => {
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-community",
      kind: "manifested",
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
        stockStatus: "in_stock",
        availabilityVerified: true,
      },
    }]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops[0].localStockStatus, "reported_watch");
  assert.equal(data.shops[0].localStockEvidence.physicalEvidenceState, "reported");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, false);
  assert.equal(data.counts.localInStockBranches, 0);
  assert.equal(data.counts.incomingWatchBranches, 1);
});

test("stale physical Manifested stock expires instead of lingering as current stock", async () => {
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-stale",
      kind: "manifested",
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
        stockStatus: "in_stock",
        availabilityVerified: true,
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

test("Echo preparation evidence remains an incoming watch and never becomes Manifested by naming alone", async () => {
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-echo",
      kind: "echo",
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
  assert.equal(data.shops[0].localStockEvidence.lifecycleState, "echo");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, false);
});

test("newer physical unavailability becomes Echo · No longer confirmed", async () => {
  const now = Date.now();
  const data = await buildLocalRadar({
    store: storeWith([
      {
        id: "evt-old-manifested",
        kind: "manifested",
        retailerId: "smyths-uk",
        locationId: "loc-romford",
        locationName: "Smyths Toys Superstores Romford",
        occurredAt: now - 10 * 60 * 1000,
        productIdentityId: "pokemon:test-etb",
        productTitle: "Test Elite Trainer Box",
        evidence: { evidenceLevel: "official_branch", confidence: 0.95, sourceType: "retailer_store_availability", stockStatus: "in_stock", availabilityVerified: true },
      },
      {
        id: "evt-new-vanished",
        kind: "vanished",
        retailerId: "smyths-uk",
        locationId: "loc-romford",
        locationName: "Smyths Toys Superstores Romford",
        occurredAt: now,
        productIdentityId: "pokemon:test-etb",
        productTitle: "Test Elite Trainer Box",
        evidence: { evidenceLevel: "official_branch", confidence: 0.95, sourceType: "retailer_store_availability" },
      },
    ]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops[0].localStockProducts.length, 1, "duplicate observations for one product collapse to one current state");
  assert.equal(data.shops[0].localStockProducts[0].lifecycleState, "echo");
  assert.equal(data.shops[0].localStockProducts[0].physicalEvidenceState, "expired");
  assert.equal(data.shops[0].localStockProducts[0].status, "no_longer_confirmed");
  assert.equal(data.shops[0].localStockProducts[0].contradictionCount, 0);
  assert.notEqual(data.shops[0].localStockStatus, "in_stock");
});

test("standalone physical unavailability remains Echo · No longer confirmed, never Vanished", async () => {
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-orphan-vanished",
      kind: "vanished",
      retailerId: "smyths-uk",
      locationId: "loc-romford",
      locationName: "Smyths Toys Superstores Romford",
      occurredAt: Date.now(),
      productIdentityId: "pokemon:test-etb",
      productTitle: "Test Elite Trainer Box",
      evidence: { evidenceLevel: "official_branch", confidence: 0.95, sourceType: "retailer_store_availability" },
    }]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops[0].localStockProducts[0].lifecycleState, "echo");
  assert.equal(data.shops[0].localStockProducts[0].physicalEvidenceState, "expired");
  assert.equal(data.shops[0].localStockProducts[0].status, "no_longer_confirmed");
  assert.equal(data.shops[0].localStockProducts[0].orphanVanished, false);
});

test("official branch Manifested availability without canonical product identity cannot become verified stock", async () => {
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "evt-unresolved-product",
      kind: "manifested",
      retailerId: "smyths-uk",
      locationId: "loc-romford",
      locationName: "Smyths Toys Superstores Romford",
      occurredAt: Date.now(),
      productIdentityId: null,
      productTitle: "Unknown Pokemon Box Name",
      evidence: { evidenceLevel: "official_branch", confidence: 0.99, sourceType: "retailer_store_availability", stockStatus: "in_stock", availabilityVerified: true },
    }]),
    retailers,
    placesSearch,
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  assert.equal(data.shops[0].localStockStatus, "unknown");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, false);
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, false);
});
