import test from "node:test";
import assert from "node:assert/strict";
import { createFateDropHttpServer } from "../src/http/fatedrop-server.mjs";

const product = {
  id: "product-1",
  title: "Audit Test Elite Trainer Box",
  productType: "sealed",
  tcg: "pokemon",
  officialRrpPence: 4999,
  rrpSource: "pokemon-center-uk",
  rrpObservedAt: 1776767000,
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
    lastSeenAt: 1776768000,
  },
  {
    offerId: "stale-shop:sku-2",
    productId: "product-1",
    retailerId: "stale-shop",
    retailerName: "Stale Shop",
    retailerSku: "sku-2",
    title: product.title,
    url: "https://example.com/stale",
    imageUrl: null,
    pricePence: 3999,
    postagePence: 0,
    stockStatus: "in_stock",
    stockConfidence: 1,
    lastSeenAt: 1776768000,
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
  async stats() { return { productsTracked: 1, offersTracked: 2, currentlyAvailable: 2 }; },
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

test("catalogue search preserves raw store history but exposes only fresh retailers", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/catalogue?q=audit&inStock=true`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.products.map((offer) => offer.retailerKey), ["fresh-shop"]);
  assert.equal(data.products.some((offer) => offer.retailerKey === "stale-shop"), false);
  assert.equal((await store.listOffers()).length, 2, "underlying historical store remains untouched");
}));

test("True Price cannot choose a cheaper preserved offer from a stale retailer", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/true-price?q=audit`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.groups.length, 1);
  assert.deepEqual(data.groups[0].offers.map((offer) => offer.retailerId), ["fresh-shop"]);
  assert.equal(data.groups[0].offers[0].isLowestKnownDelivered, true);
}));

test("Fate Verdict inherits the same fresh-offer authority boundary", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/fatefind/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "verdict", query: "audit" }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.source, "FATEDROP_CLOUD");
  assert.equal(data.groups.length, 1);
  assert.deepEqual(data.groups[0].offers.map((offer) => offer.retailerId), ["fresh-shop"]);
}));
