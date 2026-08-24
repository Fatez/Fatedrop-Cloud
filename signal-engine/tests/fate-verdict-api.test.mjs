import assert from "node:assert/strict";
import test from "node:test";

import { createHttpServer } from "../src/http/server.mjs";

const store = {
  async listOffers() {
    return [
      { offerId: "retailer-a:a", productId: "product-a", retailerId: "retailer-a", retailerName: "Retailer A", retailerSku: "a", title: "Destined Value Box A", url: "https://example.com/a", pricePence: 5000, postagePence: 0, stockStatus: "in_stock", lastSeenAt: 1776768000 },
      { offerId: "retailer-b:b", productId: "product-b", retailerId: "retailer-b", retailerName: "Retailer B", retailerSku: "b", title: "Destined Value Box B", url: "https://example.com/b", pricePence: 7000, postagePence: 0, stockStatus: "in_stock", lastSeenAt: 1776768000 },
    ];
  },
  async listProducts() {
    return [
      { id: "product-a", title: "Destined Value Box A", productType: "sealed", tcg: "pokemon", officialRrpPence: 4000, rrpSource: "verified-test", rrpObservedAt: 1776767000 },
      { id: "product-b", title: "Destined Value Box B", productType: "sealed", tcg: "pokemon", officialRrpPence: 6000, rrpSource: "verified-test", rrpObservedAt: 1776767000 },
    ];
  },
};

async function withServer(fn) {
  const server = createHttpServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("POST /api/fatefind/matches returns the canonical Cloud verdict", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/fatefind/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "verdict", query: "destined" }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.mode, "verdict");
  assert.equal(data.source, "FATEDROP_CLOUD");
  assert.equal(data.rulesVersion, "fate-verdict-v1");
  assert.equal(data.count, 2);
  assert.equal(data.verdict.basis, "rrp_percent");
  assert.equal(data.verdict.winnerId, "product-b");
}));

test("pair comparison uses the same Cloud groups and engine", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/fatefind/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "verdict", query: "destined", leftId: "product-a", rightId: "product-b" }),
  });
  const data = await response.json();
  assert.equal(data.pairVerdict.basis, "rrp_percent");
  assert.equal(data.pairVerdict.winnerId, "product-b");
  assert.equal(data.pairVerdict.left.groupId, "product-a");
  assert.equal(data.pairVerdict.right.groupId, "product-b");
}));
