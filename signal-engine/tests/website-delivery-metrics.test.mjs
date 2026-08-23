import test from "node:test";
import assert from "node:assert/strict";
import { publishWebsiteSnapshot } from "../src/notifications/website.mjs";

const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;

test("website snapshot publishes detected counts separately from Discord delivery outcomes", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.com/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";

  const store = {
    stats: async () => ({
      productsTracked: 100,
      currentlyAvailable: 20,
      signals24h: 14,
      whisper24h: 0,
      echo24h: 0,
      manifested24h: 10,
      vanished24h: 4,
    }),
    listSignals: async () => [],
    listRetailers: async () => [{ id: "retailer", healthy: true }],
    listProducts: async () => [],
    pool: async () => ({
      query: async () => ({ rows: [
        { state: "manifested", detected: 10, attempted: 8, sent: 5, skipped: 2, failed: 1, unaccounted: 2 },
        { state: "vanished", detected: 4, attempted: 4, sent: 3, skipped: 1, failed: 0, unaccounted: 0 },
      ] }),
    }),
  };

  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ stored: true }), { status: 201, headers: { "content-type": "application/json" } });
  };

  const result = await publishWebsiteSnapshot({ store, fetchImpl });
  assert.equal(result.published, true);
  assert.equal(body.metrics.manifested, 10);
  assert.equal(body.metrics.manifestedDelivered, 5);
  assert.equal(body.metrics.manifestedSkipped, 2);
  assert.equal(body.metrics.manifestedFailed, 1);
  assert.equal(body.metrics.manifestedUnaccounted, 2);
  assert.equal(body.metrics.discordDetected, 14);
  assert.equal(body.metrics.discordDelivered, 8);
  assert.equal(body.metrics.discordUnaccounted, 2);
  assert.equal(result.delivery.detected, 14);
  assert.equal(result.delivery.sent, 8);
});

test.after(() => {
  if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
  else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
});
