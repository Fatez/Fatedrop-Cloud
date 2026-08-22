import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { scanRetailerCatalogue } from "../src/adapters/catalogue-adapter.mjs";

const categoryUrl = "https://example.test/pokemon";
const productUrl = "https://example.test/pokemon/booster-box/p/12345";

function response(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

test("generic catalogue can recover from card-markup changes through bounded direct product links", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) === categoryUrl) {
      return response(`<html><body><div><a href="${productUrl}">View item</a></div></body></html>`);
    }
    if (String(url) === productUrl) {
      return response(`<html><body><main><h1>Pokemon TCG Test Booster Box</h1><div class="price">£99.99</div><div>In stock</div><div>Code: TEST-12345</div></main></body></html>`);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const retailer = {
      id: "markup-change-test",
      name: "Markup Change Test",
      catalogueUrls: [categoryUrl],
      productUrlPattern: /example\.test\/pokemon\/.*\/p\/\d+/i,
      skuPattern: /\/p\/(\d+)/i,
      pageParam: "page",
      maxPages: 1,
      delayMs: 0,
      include: /pokemon|tcg/i,
      exclude: null,
      directProductFallbackLimit: 10,
      directProductFallbackConcurrency: 2,
      directProductFallbackDelayMs: 0,
    };

    const result = await scanRetailerCatalogue(retailer);
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].retailerSku, "12345");
    assert.equal(result.products[0].pricePence, 9999);
    assert.equal(result.directFallbackProductsSeen, 1);
    assert.equal(result.partialCatalogue, false);
    assert.ok(result.pages.some((page) => page.source === "direct_product_fallback"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("Magic Madhouse keeps a bounded safety guard while allowing the observed catalogue growth", async () => {
  const source = await readFile(new URL("../src/adapters/bigcommerce-sitemap-adapter.mjs", import.meta.url), "utf8");
  assert.match(source, /configuredMaxProductPages === 800/);
  assert.match(source, /\? 1200/);
  assert.match(source, /assertWithinSafetyCap/);
});
