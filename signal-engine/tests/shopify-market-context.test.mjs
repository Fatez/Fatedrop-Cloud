import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/adapters/structured-catalogue-adapter.mjs";
import { normalizeShopifyProducts } from "../src/adapters/shopify-normalizer.mjs";

const { DEFAULT_SHOPIFY_MARKET_COUNTRY, shopifyMarketCountry, shopifyPageUrl } = __test;

test("Shopify scans default to the UK presentment market", () => {
  assert.equal(DEFAULT_SHOPIFY_MARKET_COUNTRY, "GB");
  assert.equal(shopifyMarketCountry({ catalogue: {} }), "GB");

  const url = new URL(shopifyPageUrl("https://card-collective.com/collections/pokemon-tcg/products.json?limit=250", 1));
  assert.equal(url.searchParams.get("limit"), "250");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("country"), "GB");
});

test("Shopify market can be explicitly overridden for future non-UK retailers", () => {
  assert.equal(shopifyMarketCountry({ catalogue: { marketCountry: "us" } }), "US");
  assert.equal(shopifyMarketCountry({ marketCountry: "jp", catalogue: {} }), "JP");
  assert.equal(shopifyMarketCountry({ catalogue: { marketCountry: "invalid" } }), "GB");

  const url = new URL(shopifyPageUrl("https://example.com/products.json", 3, "US"));
  assert.equal(url.searchParams.get("country"), "US");
  assert.equal(url.searchParams.get("page"), "3");
  assert.equal(url.searchParams.get("limit"), "250");
});

test("Shopify normalizer preserves the market-returned variant price without FX conversion", () => {
  const [offer] = normalizeShopifyProducts({
    products: [{
      title: "Terastal Grand Gathering Booster Box- Simplified Chinese",
      handle: "pokemon-tcg-terastal-grand-gathering-booster-box-simplified-chinese",
      variants: [{
        id: 58272935772541,
        title: "Sealed",
        price: "69.95",
        available: true,
      }],
    }],
  }, {
    id: "card-collective",
    name: "Card Collective UK",
    baseUrl: "https://card-collective.com/",
  });

  assert.equal(offer.retailerSku, "58272935772541");
  assert.equal(offer.pricePence, 6995);
  assert.equal(offer.stockStatus, "in_stock");
  assert.equal(offer.stockConfidence, 0.98);
});
