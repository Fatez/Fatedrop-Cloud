import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http/server.mjs";

const now = Math.floor(Date.now() / 1000);
const history = [
  { id: "m1", state: "manifested", productId: "prd-1", offerId: "off-1", retailerId: "ret-1", retailerName: "Retailer One", title: "Test Product", detectedAt: now - 600, pricePence: 1995 },
  { id: "v1", state: "vanished", productId: "prd-1", offerId: "off-1", retailerId: "ret-1", retailerName: "Retailer One", title: "Test Product", detectedAt: now - 540, pricePence: 1995 },
  { id: "m2", state: "manifested", productId: "prd-1", offerId: "off-1", retailerId: "ret-1", retailerName: "Retailer One", title: "Test Product", detectedAt: now - 400, pricePence: 1995 },
  { id: "v2", state: "vanished", productId: "prd-1", offerId: "off-1", retailerId: "ret-1", retailerName: "Retailer One", title: "Test Product", detectedAt: now - 280, pricePence: 1995 },
];

const store = {
  async listAvailabilitySignals({ productId = null, offerId = null, retailerId = null, since = 0, limit = 500 } = {}) {
    return history
      .filter((signal) => signal.detectedAt >= since)
      .filter((signal) => !productId || signal.productId === productId)
      .filter((signal) => !offerId || signal.offerId === offerId)
      .filter((signal) => !retailerId || signal.retailerId === retailerId)
      .sort((a, b) => b.detectedAt - a.detectedAt)
      .slice(0, limit);
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

test("gated availability endpoint returns historical Manifested-to-Vanished intelligence", async () => withServer(async (base) => {
  const response = await fetch(`${base}/v1/availability-intelligence?productId=prd-1`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.productId, "prd-1");
  assert.equal(data.availability.basis, "manifested_to_vanished");
  assert.equal(data.availability.sampleCount, 2);
  assert.equal(data.availability.typicalAvailabilitySeconds, 90);
  assert.equal(data.availability.averageAvailabilitySeconds, 90);
  assert.equal(data.availability.byRetailer[0].retailerId, "ret-1");
}));

test("availability endpoint requires a product or offer identity", async () => withServer(async (base) => {
  const response = await fetch(`${base}/v1/availability-intelligence`);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /productId or offerId/);
}));
