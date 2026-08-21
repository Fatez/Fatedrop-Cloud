import test from "node:test";
import assert from "node:assert/strict";
import { extractDirectProductPage } from "../src/core/extract.mjs";
import { scanRetailer } from "../src/core/engine.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

const retailer = {
  id: "magic-madhouse",
  name: "Magic Madhouse",
  tcg: "pokemon",
  adapterType: ADAPTER_TYPES.GENERIC_HTML,
  officialRrpSource: false,
  productUrlPattern: /magicmadhouse\.co\.uk\/pokemon-[a-z0-9][a-z0-9-]+\/?(?:\?.*)?$/i,
  skuPattern: /\/pokemon-([^/?#]+)/i,
};

test("Magic Madhouse standalone product evidence parses Silver Tempest stock and price", () => {
  const html = `
    <html><body><main><div class="productView">
      <h1 class="productView-title">SWSH Silver Tempest Booster Box</h1>
      <span class="price price--withoutTax">£599.95</span>
      <div data-product-sku>PZZSWSH12BB</div>
      <div>10+ in stock</div>
      <button>Add to Basket</button>
      <img alt="SWSH Silver Tempest Booster Box product" src="/images/silver-tempest.jpg">
    </div></main></body></html>`;

  const product = extractDirectProductPage({
    html,
    pageUrl: "https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box",
    retailer,
  });

  assert.ok(product);
  assert.equal(product.title, "SWSH Silver Tempest Booster Box");
  assert.equal(product.retailerSku, "PZZSWSH12BB");
  assert.equal(product.pricePence, 59995);
  assert.equal(product.stockStatus, "in_stock");
  assert.equal(product.stockConfidence, 0.98);
  assert.equal(product.evidence[0].kind, "product_page_probe");
});

test("partial product probes can create a real lifecycle signal but cannot mark the retailer healthy", async () => {
  const saved = [];
  const failures = [];
  const rawProduct = {
    retailerSku: "PZZSWSH12BB",
    title: "SWSH Silver Tempest Booster Box",
    url: "https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box",
    imageUrl: null,
    pricePence: 59995,
    productType: "booster_box",
    canonicalKey: "swsh-silver-tempest-booster-box:booster_box",
    stockStatus: "in_stock",
    stockConfidence: 0.98,
    stockQuantity: null,
    evidence: [{ kind: "product_page_probe", value: "in stock", pageUrl: "https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box" }],
  };
  const store = {
    async isBaselineComplete() { return true; },
    async getProduct() { return null; },
    async getOffer() { return null; },
    async saveScan(payload) { saved.push(payload); },
    async recordFailure(_retailer, error) { failures.push(String(error?.message || error)); },
  };

  const result = await scanRetailer({
    retailer,
    store,
    now: 1_787_300_000,
    scanSource: async () => ({
      products: [rawProduct],
      pages: [
        { source: "catalogue", discovered: 0, status: 200 },
        { source: "product_probe", discovered: 1, status: 200 },
      ],
      partialCatalogue: true,
      catalogueProductsSeen: 0,
      probeProductsSeen: 1,
    }),
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].signals.length, 1);
  assert.equal(saved[0].signals[0].state, "manifested");
  assert.equal(saved[0].signals[0].title, "SWSH Silver Tempest Booster Box");
  assert.equal(result.signalsCreated, 1);
  assert.equal(result.partialCatalogue, true);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /remains unhealthy until full catalogue discovery is restored/i);
});
