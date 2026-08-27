import test from "node:test";
import assert from "node:assert/strict";
import { createFateDropHttpServer } from "../src/http/fatedrop-server.mjs";

const observedAt = Math.floor(Date.now() / 1000);
const store = {
  async listOffers() {
    return [
      { offerId: "fresh:1", retailerId: "fresh-shop", stockStatus: "in_stock", lastSeenAt: observedAt },
      { offerId: "stale:1", retailerId: "stale-shop", stockStatus: "in_stock", lastSeenAt: observedAt },
    ];
  },
  async listRetailers() {
    return [
      { id: "fresh-shop", healthy: true, stale: false, baselineCompleted: true },
      { id: "stale-shop", healthy: false, stale: true, baselineCompleted: true },
    ];
  },
  async listEncounters() { return []; },
  async stats() { return { productsTracked: 0, offersTracked: 2, currentlyAvailable: 2 }; },
  async listSignals() { return []; },
  async listProducts() { return []; },
  async listNetworkSnapshots() { return []; },
};

const retailers = [
  { id: "fresh-shop", name: "Fresh Shop", baseUrl: "https://fresh.example.com" },
  { id: "stale-shop", name: "Stale Shop", baseUrl: "https://stale.example.com" },
];

async function placesSearch() {
  return {
    status: "ok",
    provider: "test_places",
    shops: [
      {
        id: "place-fresh",
        itemType: "shop",
        name: "Fresh Shop",
        websiteUrl: "https://fresh.example.com",
        latitude: 51.5,
        longitude: -0.1,
      },
      {
        id: "place-stale",
        itemType: "shop",
        name: "Stale Shop",
        websiteUrl: "https://stale.example.com",
        latitude: 51.5,
        longitude: -0.1,
      },
    ],
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

test("Local Radar preserves connected retailer identity but counts only fresh online offers", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/local-radar?types=shops&lat=51.5&lng=-0.1&radiusMiles=10`);
  assert.equal(response.status, 200);
  const data = await response.json();
  const fresh = data.shops.find((shop) => shop.retailerId === "fresh-shop");
  const stale = data.shops.find((shop) => shop.retailerId === "stale-shop");
  assert.equal(fresh.networkStatus, "live_connected");
  assert.equal(fresh.onlineCatalogue.availableOffers, 1);
  assert.equal(stale.networkStatus, "live_connected", "connection identity is historical/configuration truth, not a stock claim");
  assert.equal(stale.onlineCatalogue.availableOffers, 0, "stale preserved offers cannot be reported as currently available");
}));
