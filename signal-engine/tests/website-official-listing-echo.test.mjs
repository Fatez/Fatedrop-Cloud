import assert from "node:assert/strict";
import test from "node:test";
import { publishWebsiteSnapshot } from "../src/notifications/website.mjs";

const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;

test("verified official-listing Echo keeps its precise kind and major priority in the Web snapshot", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.test/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  const now = Math.floor(Date.now() / 1000);
  const store = {
    stats: async () => ({ echo24h: 1 }),
    listSignals: async () => [{
      id: "sig-official-listing",
      state: "echo",
      kind: "retailer_preparation",
      retailerId: "pokemon-center-uk",
      retailerName: "Pokémon Center UK",
      retailerSku: "10-10451-101",
      productId: "prd-30th-bundle",
      offerId: "pokemon-center-uk:10-10451-101",
      title: "Pokémon TCG: 30th Celebration Booster Bundle (6 Packs)",
      url: "https://www.pokemoncenter.com/en-gb/product/10-10451-101/example",
      stockStatus: "preorder",
      confidence: 0.96,
      detectedAt: now,
      evidence: [
        { kind: "retailer_preparation_official_listing", value: "verified_official_product_page", observedAt: now },
        { kind: "signal_kind", value: "retailer_preparation", observedAt: now },
      ],
    }],
    listRetailers: async () => [{ id: "pokemon-center-uk", healthy: true }],
  };

  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ stored: true }), { status: 201, headers: { "content-type": "application/json" } });
  };

  const result = await publishWebsiteSnapshot({ store, fetchImpl });
  assert.equal(result.published, true);
  assert.equal(body.recentSignals.length, 1);
  assert.equal(body.recentSignals[0].state, "echo");
  assert.equal(body.recentSignals[0].kind, "retailer_preparation");
  assert.equal(body.recentSignals[0].intensity, "major");
  assert.equal(body.recentSignals[0].retailerId, "pokemon-center-uk");
});

test.after(() => {
  if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
  else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
});
