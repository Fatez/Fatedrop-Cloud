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

test("website publisher sends canonical lifecycle plus links, identity and RRP price context", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.com/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";

  const now = Math.floor(Date.now() / 1000);
  const store = {
    stats: async () => ({ productsTracked: 937, currentlyAvailable: 200, signals24h: 4, whisper24h: 1, manifested24h: 1, vanished24h: 1, echo24h: 1 }),
    listSignals: async () => [
      {
        id: "sig-1",
        state: "manifested",
        productId: "prd-1",
        offerId: "off-1",
        retailerId: "smyths-uk",
        retailerName: "Smyths Toys UK",
        retailerSku: "123456",
        title: "Test ETB",
        url: "https://example.com/product/123456",
        imageUrl: "https://example.com/product.jpg",
        pricePence: 4999,
        rrpPence: 4999,
        postagePence: 0,
        deliveredPricePence: 4999,
        markupPercent: 0,
        stockStatus: "in_stock",
        reason: "Retailer SKU availability became verified",
        detectedAt: now,
        evidence: [
          { kind: "signal_kind", value: "availability_live", lifecycle: "manifested", observedAt: now },
          { kind: "signal_alert_class", value: "primary_drop", observedAt: now },
          { kind: "retailer_sku", value: "123456", observedAt: now },
        ],
      },
      { id: "legacy-noise", state: "drop_pulse", retailerId: "smyths-uk", title: "Context only", detectedAt: now },
    ],
    listRetailers: async () => [{ id: "test", healthy: true }],
    listProducts: async () => [],
    getProduct: async () => null,
    getOffer: async () => null,
  };

  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ stored: true }), { status: 201, headers: { "content-type": "application/json" } });
  };

  const result = await publishWebsiteSnapshot({ store, fetchImpl });
  assert.equal(result.published, true);
  const body = JSON.parse(request.options.body);
  assert.equal(body.recentSignals.length, 1);
  const published = body.recentSignals[0];
  assert.equal(published.state, "manifested");
  assert.equal(published.kind, "availability_live");
  assert.equal(published.alertClass, "primary_drop");
  assert.equal(published.productId, "prd-1");
  assert.equal(published.offerId, "off-1");
  assert.equal(published.retailerId, "smyths-uk");
  assert.equal(published.retailerSku, "123456");
  assert.equal(published.retailerUrl, "https://example.com/product/123456");
  assert.equal(published.imageUrl, "https://example.com/product.jpg");
  assert.equal(published.pricePence, 4999);
  assert.equal(published.rrpPence, 4999);
  assert.equal(published.postagePence, 0);
  assert.equal(published.deliveredPricePence, 4999);
  assert.equal(published.markupPercent, 0);
  assert.equal(published.rrpPosition, "at_rrp");
});

test("legacy queue and security states normalize to Echo with their exact causes", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.com/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  const now = Math.floor(Date.now() / 1000);
  const store = {
    stats: async () => ({ echo24h: 2 }),
    listSignals: async () => [
      { id:"queue-1", state:"queue", retailerId:"pokemon-center-uk", retailerName:"Pokémon Center UK", title:"Queue", reason:"Queue", detectedAt:now },
      { id:"security-1", state:"security", retailerId:"pokemon-center-uk", retailerName:"Pokémon Center UK", title:"Security", reason:"Security", detectedAt:now-1 },
    ],
    listRetailers: async () => [],
    listProducts: async () => [],
    getProduct: async () => null,
    getOffer: async () => null,
  };
  let body;
  const fetchImpl = async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({stored:true}), {status:201,headers:{"content-type":"application/json"}}); };
  await publishWebsiteSnapshot({store,fetchImpl});
  assert.deepEqual(body.recentSignals.map((signal)=>[signal.state,signal.kind,signal.intensity]),[["echo","queue","major"],["echo","security","major"]]);
});

test("market signals calculate actual markup rather than assuming a fixed indie premium", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.com/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  const now = Math.floor(Date.now() / 1000);
  const store = {
    stats: async () => ({}),
    listSignals: async () => [{
      id: "sig-market",
      state: "manifested",
      retailerId: "titan-cards",
      retailerName: "Titan Cards",
      retailerSku: "TITAN-ETB-1",
      title: "Example ETB",
      url: "https://example.com/titan-etb",
      pricePence: 5749,
      rrpPence: 4999,
      postagePence: 399,
      stockStatus: "in_stock",
      detectedAt: now,
      evidence: [],
    }],
    listRetailers: async () => [],
    listProducts: async () => [],
    getProduct: async () => null,
    getOffer: async () => null,
  };
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ stored: true }), { status: 201, headers: { "content-type": "application/json" } });
  };
  await publishWebsiteSnapshot({ store, fetchImpl });
  const published = body.recentSignals[0];
  assert.equal(published.alertClass, "market_stock");
  assert.equal(published.retailerSku, "TITAN-ETB-1");
  assert.equal(published.deliveredPricePence, 6148);
  assert.ok(Math.abs(published.markupPercent - 15.003000600120024) < 0.000001);
  assert.equal(published.rrpPosition, "above_rrp");
});

test("website publisher can infer market alert family for older lifecycle rows", async () => {
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://example.com/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  const store = {
    stats: async () => ({}),
    listSignals: async () => [{ id: "sig-market", state: "vanished", retailerId: "titan-cards", retailerName: "Titan Cards", title: "Example", detectedAt: Math.floor(Date.now() / 1000), evidence: [] }],
    listRetailers: async () => [],
    listProducts: async () => [],
    getProduct: async () => null,
    getOffer: async () => null,
  };
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ stored: true }), { status: 201, headers: { "content-type": "application/json" } });
  };
  await publishWebsiteSnapshot({ store, fetchImpl });
  assert.equal(body.recentSignals[0].state, "vanished");
  assert.equal(body.recentSignals[0].kind, "lifecycle_unspecified");
  assert.equal(body.recentSignals[0].alertClass, "market_stock");
});

test.after(() => {
  if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
  else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
});