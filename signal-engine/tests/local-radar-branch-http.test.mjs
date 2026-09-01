import test from "node:test";
import assert from "node:assert/strict";
import { createFateDropHttpServer } from "../src/http/fatedrop-server.mjs";

const now = Date.now();
const store = {
  async listOffers() { return []; },
  async listRetailers() { return [{ id: "smyths-uk", healthy: true, stale: false, baselineCompleted: true }]; },
  async listRetailerLocations() {
    return [{
      id: "loc-http-test",
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
  async listLocalStockObservations() {
    return [{
      id: "local-http-test",
      kind: "manifested",
      retailerId: "smyths-uk",
      locationId: "loc-http-test",
      locationName: "Smyths Toys Superstores Romford",
      occurredAt: now,
      productIdentityId: "pokemon:http-test",
      productTitle: "HTTP Test ETB",
      evidence: {
        evidenceLevel: "official_branch",
        confidence: 0.98,
        sourceType: "retailer_store_availability",
        stockStatus: "in_stock",
        availabilityVerified: true,
      },
    }];
  },
  async stats() { return { productsTracked: 0, offersTracked: 0, currentlyAvailable: 0 }; },
  async listSignals() { return []; },
  async listProducts() { return []; },
  async listNetworkSnapshots() { return []; },
};

const retailers = [{ id: "smyths-uk", name: "Smyths Toys UK", baseUrl: "https://www.smythstoys.com/uk/en-gb/" }];

async function placesSearch() {
  return {
    status: "ok",
    provider: "test_places",
    shops: [{
      id: "place-http-smyths",
      itemType: "shop",
      provider: "google_places",
      providerPlaceId: "http-smyths",
      name: "Smyths Toys Superstores Romford",
      address: "Romford",
      latitude: 51.58,
      longitude: 0.18,
      websiteUrl: null,
      localStockStatus: "unknown",
    }],
  };
}

async function withServer(fn) {
  const server = createFateDropHttpServer({ store, retailers, placesSearch });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Local Radar HTTP response preserves fresh verified branch Echo stock and counts", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/local-radar?types=shops&lat=51.58&lng=0.18&radiusMiles=10`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.providers.localStock.status, "ok");
  assert.equal(data.counts.localInStockBranches, 1);
  assert.equal(data.counts.incomingWatchBranches, 0);
  assert.equal(data.shops[0].localStockStatus, "in_stock");
  assert.equal(data.shops[0].localStockEvidence.lifecycleState, "echo");
  assert.equal(data.shops[0].localStockEvidence.physicalEvidenceState, "verified");
  assert.equal(data.shops[0].localStockEvidence.verifiedBranchStock, true);
  assert.equal(data.shops[0].localStockProducts[0].title, "HTTP Test ETB");
}));
