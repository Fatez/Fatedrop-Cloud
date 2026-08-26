import assert from "node:assert/strict";
import test from "node:test";
import { publishWebsiteSnapshot } from "../src/notifications/website.mjs";

const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;

function restore() {
  if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
  else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
}

test("periodic Web snapshot is telemetry-only and never replays the product/offer catalogue", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.test/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";

  let body;
  const store = {
    stats: async () => ({ productsTracked: 10, currentlyAvailable: 2 }),
    listSignals: async () => [],
    listRetailers: async () => [{ id: "retailer", healthy: true }],
    listProducts: async () => { throw new Error("periodic snapshot must not load the product catalogue"); },
    getProduct: async () => { throw new Error("periodic snapshot must not build offer opportunities"); },
    getOffer: async () => { throw new Error("periodic snapshot must not build offer opportunities"); },
  };

  const result = await publishWebsiteSnapshot({
    store,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ stored: true }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(result.published, true);
  assert.equal(result.snapshotMode, "telemetry_only");
  assert.equal(body.snapshotMode, "telemetry_only");
  assert.deepEqual(body.rrpReferenceProducts, []);
  assert.deepEqual(body.opportunities, []);
});

test.after(restore);
