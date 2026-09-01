import test from "node:test";
import assert from "node:assert/strict";

import { scanStructuredCatalogue, __test as structuredTest } from "../src/adapters/structured-catalogue-adapter.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

function wooProduct(id, title = `Pokemon Booster Pack ${id}`) {
  return {
    id,
    sku: `SKU-${id}`,
    name: title,
    permalink: `https://example.co.uk/product/${id}`,
    is_in_stock: true,
    prices: { price: "499", currency_minor_unit: 2 },
    images: [],
  };
}

function retailer(overrides = {}) {
  return {
    id: "wave-woo",
    name: "Wave Woo",
    tcg: "pokemon",
    adapterType: ADAPTER_TYPES.WOOCOMMERCE,
    baseUrl: "https://example.co.uk/",
    catalogue: {
      feedUrl: "https://example.co.uk/wp-json/wc/store/v1/products?per_page=2&search=Pokemon",
      feedApproved: true,
      runtime: { maxPages: 4, delayMs: 250 },
    },
    include: /booster|elite trainer|\betb\b|collection|tin\b|box\b|pack\b/i,
    exclude: /single|sleeve|binder|event ticket/i,
    ...overrides,
  };
}

test("Woo page helper preserves filters and adds bounded page number", () => {
  const url = new URL(structuredTest.wooPageUrl("https://example.co.uk/api?per_page=100&search=Pokemon", 3));
  assert.equal(url.searchParams.get("per_page"), "100");
  assert.equal(url.searchParams.get("search"), "Pokemon");
  assert.equal(url.searchParams.get("page"), "3");
  assert.equal(structuredTest.wooPageSize(url.toString()), 100);
});

test("Woo structured scan walks subsequent pages until the catalogue is complete", async () => {
  const requested = [];
  const fetchJson = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    requested.push(page);
    if (page === 1) return { payload: [wooProduct(1), wooProduct(2)], status: 200 };
    if (page === 2) return { payload: [wooProduct(3)], status: 200 };
    throw new Error(`Unexpected page ${page}`);
  };

  const result = await scanStructuredCatalogue(retailer(), { fetchJson, sleepFn: async () => {} });

  assert.deepEqual(requested, [1, 2]);
  assert.equal(result.products.length, 3);
  assert.equal(result.pages.length, 2);
  assert.equal(result.complete, true);
  assert.equal(result.partialCatalogue, false);
  assert.equal(result.pageLimitReached, false);
});

test("Woo structured scan fails closed as partial when its configured page cap is exhausted", async () => {
  const fetchJson = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return { payload: [wooProduct(page * 10 + 1), wooProduct(page * 10 + 2)], status: 200 };
  };

  const result = await scanStructuredCatalogue(retailer({
    catalogue: {
      feedUrl: "https://example.co.uk/wp-json/wc/store/v1/products?per_page=2&search=Pokemon",
      feedApproved: true,
      runtime: { maxPages: 2, delayMs: 250 },
    },
  }), { fetchJson, sleepFn: async () => {} });

  assert.equal(result.products.length, 4);
  assert.equal(result.complete, false);
  assert.equal(result.partialCatalogue, true);
  assert.equal(result.pageLimitReached, true);
});
