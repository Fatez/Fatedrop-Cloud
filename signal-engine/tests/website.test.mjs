import test from "node:test";
import assert from "node:assert/strict";
import { publishWebsiteSnapshot } from "../src/notifications/website.mjs";

const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;

test("website publisher skips safely when not configured", async () => {
  delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  delete process.env.FATEDROP_METRICS_INGEST_SECRET;
  const result = await publishWebsiteSnapshot({ store: {} });
  assert.equal(result.published, false);
  assert.equal(result.reason, "not_configured");
});

test("website publisher sends current metrics and lifecycle signals", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.com/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";

  const store = {
    stats: async () => ({ productsTracked: 937, currentlyAvailable: 200, signals24h: 4, whisper24h: 1, manifested24h: 1, vanished24h: 1, echo24h: 1 }),
    listSignals: async () => [{ id: "sig-1", state: "echo", title: "Test ETB", retailerName: "Test Retailer", reason: "Stock returned", deliveredPricePence: 4999, detectedAt: Math.floor(Date.now() / 1000) }],
    listRetailers: async () => [{ id: "test", healthy: true }],
  };

  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ stored: true }), { status: 201, headers: { "content-type": "application/json" } });
  };

  const result = await publishWebsiteSnapshot({ store, fetchImpl });
  assert.equal(result.published, true);
  assert.equal(request.url, "https://example.com/api/dashboard/network-snapshot");
  assert.equal(request.options.headers.Authorization, "Bearer test-secret");
  const body = JSON.parse(request.options.body);
  assert.equal(body.metrics.productsTracked, 937);
  assert.equal(body.metrics.echo, 1);
  assert.equal(body.recentSignals[0].state, "echo");
  assert.equal(body.recentSignals[0].title, "Test ETB");
});

test.after(() => {
  if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
  else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
});
