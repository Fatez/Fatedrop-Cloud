import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.mjs";
import {
  normalizeLocalStockObservationBatch,
  normalizeRetailerLocation,
} from "../src/encounters/local-stock-store.mjs";
import { createFateDropHttpServer } from "../src/http/fatedrop-server.mjs";

test("exact retailer location identity is deterministic for the same provider branch ID", () => {
  const a = normalizeRetailerLocation({
    retailerId: "tesco-uk",
    provider: "tesco_store",
    providerId: "cheshunt-123",
    name: "Tesco Cheshunt",
    latitude: 51.7,
    longitude: -0.03,
    postcode: "EN8 9XQ",
  });
  const b = normalizeRetailerLocation({
    retailerId: "tesco-uk",
    provider: "tesco_store",
    providerId: "cheshunt-123",
    name: "Tesco Cheshunt Extra",
    latitude: 51.7001,
    longitude: -0.0301,
    postcode: "EN8 9XQ",
  });
  assert.equal(a.id, b.id);
  assert.equal(a.providerId, "cheshunt-123");
});

test("identical source observations in the same minute dedupe to one canonical event", () => {
  const base = {
    kind: "echo",
    retailerId: "tesco-uk",
    locationId: "loc_tesco_cheshunt",
    productIdentityId: "pokemon:destined-rivals-etb",
    occurredAt: 1787720400000,
    evidence: {
      evidenceLevel: "official_branch",
      sourceType: "inventory_preparation",
      sourceId: "tesco:cheshunt:destined-rivals",
      rawProductTitle: "Destined Rivals ETB",
    },
  };
  const batch = normalizeLocalStockObservationBatch([base, { ...base, occurredAt: 1787720430000 }]);
  assert.equal(batch.accepted, 1);
  assert.equal(batch.observations[0].kind, "echo");
});

test("invalid Manifested evidence is rejected before persistence", () => {
  const batch = normalizeLocalStockObservationBatch([{
    kind: "manifested",
    retailerId: "tesco-uk",
    locationId: "loc_tesco_cheshunt",
    productIdentityId: "pokemon:destined-rivals-etb",
    occurredAt: Date.now(),
    evidence: {
      evidenceLevel: "community_report",
      sourceType: "community_sighting",
      sourceId: "report-1",
      stockStatus: "in_stock",
      availabilityVerified: true,
    },
  }]);
  assert.equal(batch.accepted, 0);
  assert.match(batch.rejected[0].reason, /requires official/i);
});

function makeStore() {
  const state = { locations: [], observations: [] };
  return {
    state,
    async listOffers() { return []; },
    async listRetailers() { return []; },
    async listProducts() { return []; },
    async listSignals() { return []; },
    async listNetworkSnapshots() { return []; },
    async stats() { return { productsTracked: 0, offersTracked: 0, currentlyAvailable: 0 }; },
    async upsertRetailerLocations(locations) { state.locations.push(...locations); return { saved: locations.length }; },
    async upsertLocalStockObservations(observations) { state.observations.push(...observations); return { saved: observations.length, duplicates: 0 }; },
    async hasPriorLocalManifested() { return false; },
  };
}

async function withServer(store, fn) {
  const server = createFateDropHttpServer({ store, retailers: [] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("branch and lifecycle ingest endpoints are secret-protected and reject orphan Vanished", async () => {
  const previousSecret = env.ingestSecret;
  env.ingestSecret = "local-radar-test-secret";
  const store = makeStore();
  try {
    await withServer(store, async (base) => {
      const locationPayload = {
        locations: [{
          retailerId: "tesco-uk",
          provider: "tesco_store",
          providerId: "cheshunt-123",
          name: "Tesco Cheshunt",
          address: "Cheshunt",
          postcode: "EN8 9XQ",
          latitude: 51.7,
          longitude: -0.03,
          verification: "source_verified",
        }],
      };
      const denied = await fetch(`${base}/internal/local-radar/locations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(locationPayload),
      });
      assert.equal(denied.status, 401);

      const locationResponse = await fetch(`${base}/internal/local-radar/locations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fatedrop-secret": "local-radar-test-secret" },
        body: JSON.stringify(locationPayload),
      });
      assert.equal(locationResponse.status, 200);
      assert.equal(store.state.locations.length, 1);
      const locationId = store.state.locations[0].id;

      const manifested = await fetch(`${base}/internal/local-radar/observations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fatedrop-secret": "local-radar-test-secret" },
        body: JSON.stringify({ observations: [{
          kind: "manifested",
          retailerId: "tesco-uk",
          locationId,
          productIdentityId: "pokemon:destined-rivals-etb",
          occurredAt: Date.now(),
          evidence: {
            evidenceLevel: "official_branch",
            sourceType: "retailer_store_availability",
            sourceId: "tesco-stock-check-1",
            stockStatus: "in_stock",
            availabilityVerified: true,
            itemPricePence: 4999,
          },
        }] }),
      });
      assert.equal(manifested.status, 200);
      assert.equal(store.state.observations.length, 1);
      assert.equal(store.state.observations[0].kind, "manifested");

      const vanished = await fetch(`${base}/internal/local-radar/observations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fatedrop-secret": "local-radar-test-secret" },
        body: JSON.stringify({ observations: [{
          kind: "vanished",
          retailerId: "tesco-uk",
          locationId,
          productIdentityId: "pokemon:another-product",
          occurredAt: Date.now(),
          evidence: {
            evidenceLevel: "official_branch",
            sourceType: "retailer_store_availability",
            sourceId: "tesco-stock-check-2",
          },
        }] }),
      });
      assert.equal(vanished.status, 200);
      const vanishedBody = await vanished.json();
      assert.equal(vanishedBody.persisted.saved, 0);
      assert.equal(vanishedBody.rejected.length, 1);
      assert.match(vanishedBody.rejected[0].reason, /prior Manifested/i);
    });
  } finally {
    env.ingestSecret = previousSecret;
  }
});
