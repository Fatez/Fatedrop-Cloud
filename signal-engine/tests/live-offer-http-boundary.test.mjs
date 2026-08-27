import test from "node:test";
import assert from "node:assert/strict";
import { createFateDropHttpServer } from "../src/http/fatedrop-server.mjs";

const NOW = Math.floor(Date.now() / 1000);
const product = {
  id: "product-1",
  title: "Audit Test Elite Trainer Box",
  productType: "sealed",
  tcg: "pokemon",
  officialRrpPence: 4999,
  rrpSource: "pokemon-center-uk",
  rrpObservedAt: NOW - 3600,
};

const offers = [
  {
    offerId: "fresh-shop:sku-1",
    productId: "product-1",
    retailerId: "fresh-shop",
    retailerName: "Fresh Shop",
    retailerSku: "sku-1",
    title: product.title,
    url: "https://example.com/fresh",
    imageUrl: null,
    pricePence: 5499,
    postagePence: 0,
    stockStatus: "in_stock",
    stockConfidence: 1,
    lastSeenAt: NOW - 30,
  },
  {
    offerId: "fresh-shop:stale-sku",
    productId: "product-1",
    retailerId: "fresh-shop",
    retailerName: "Fresh Shop",
    retailerSku: "stale-sku",
    title: product.title,
    url: "https://example.com/preserved-stale-offer",
    imageUrl: null,
    pricePence: 2999,
    postagePence: 0,
    stockStatus: "in_stock",
    stockConfidence: 1,
    lastSeenAt: NOW - 1801,
  },
  {
    offerId: "stale-shop:sku-2",
    productId: "product-1",
    retailerId: "stale-shop",
    retailerName: "Stale Shop",
    retailerSku: "sku-2",
    title: product.title,
    url: "https://example.com/stale-retailer",
    imageUrl: null,
    pricePence: 3999,
    postagePence: 0,
    stockStatus: "in_stock",
    stockConfidence: 1,
    lastSeenAt: NOW - 30,
  },
];

const store = {
  async listOffers() { return offers; },
  async listProducts() { return [product]; },
  async listRetailers() {
    return [
      { id: "fresh-shop", name: "Fresh Shop", healthy: true, stale: false, baselineCompleted: true },
      { id: "stale-shop", name: "Stale Shop", healthy: true, stale: true, baselineCompleted: true },
    ];
  },
  async stats() { return { productsTracked: 1, offersTracked: 3, currentlyAvailable: 3 }; },
  async listSignals() { return []; },
  async listNetworkSnapshots() { return []; },
};

async function withServer(fn) {
  const server = createFateDropHttpServer({ store, retailers: [] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("catalogue search preserves raw store history but exposes only fresh retailer + offer observations", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/catalogue?q=audit&inStock=true`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.products.map((offer) => offer.id), ["fresh-shop:sku-1"]);
  assert.equal(data.products.some((offer) => offer.id === "fresh-shop:stale-sku"), false);
  assert.equal(data.products.some((offer) => offer.retailerKey === "stale-shop"), false);
  assert.equal((await store.listOffers()).length, 3, "underlying historical store remains untouched");
}));

test("True Price cannot choose a cheaper preserved stale offer from an otherwise healthy retailer", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/true-price?q=audit`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.groups.length, 1);
  assert.deepEqual(data.groups[0].offers.map((offer) => offer.id), ["fresh-shop:sku-1"]);
  assert.equal(data.groups[0].offers[0].isLowestKnownDelivered, true);
}));

test("Fate Verdict inherits the same retailer and individual-offer freshness authority boundary", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/fatefind/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "verdict", query: "audit" }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.source, "FATEDROP_CLOUD");
  assert.equal(data.groups.length, 1);
  assert.deepEqual(data.groups[0].offers.map((offer) => offer.id), ["fresh-shop:sku-1"]);
}));
