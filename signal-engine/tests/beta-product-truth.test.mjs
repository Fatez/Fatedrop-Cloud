import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShopifyProducts } from "../src/adapters/shopify-normalizer.mjs";
import { processRetailerProducts } from "../src/core/engine.mjs";

function memoryStore({ baselineComplete = true } = {}) {
  const state = { products: [], offers: [], observations: [], signals: [] };
  return {
    state,
    async isBaselineComplete() { return baselineComplete; },
    async getProduct() { return null; },
    async getOffer() { return null; },
    async saveScan(payload) {
      state.products.push(...payload.products);
      state.offers.push(...payload.offers);
      state.observations.push(...payload.observations);
      state.signals.push(...payload.signals);
    },
  };
}

test("Shopify barcode is retained as GTIN without changing price or stock", () => {
  const [row] = normalizeShopifyProducts({
    products: [{
      id: 1,
      title: "Perfect Order Elite Trainer Box",
      handle: "perfect-order-etb",
      variants: [{ id: 11, sku: "PO-ETB", title: "Default Title", price: "59.99", available: true, barcode: "0820650857980" }],
    }],
  }, { baseUrl: "https://shop.example/" });
  assert.equal(row.gtin, "0820650857980");
  assert.equal(row.pricePence, 5999);
  assert.equal(row.stockStatus, "in_stock");
  assert.ok(row.evidence.some((entry) => entry.kind === "gtin" && entry.value === "0820650857980"));
});

test("official retailer selling price is never silently promoted to RRP", async () => {
  const store = memoryStore();
  await processRetailerProducts({
    retailer: { id: "official-store", name: "Official Store", tcg: "pokemon", officialRrpSource: true },
    store,
    rawProducts: [{
      retailerSku: "SKU-1",
      title: "Perfect Order Elite Trainer Box",
      url: "https://official.example/product/sku-1",
      pricePence: 5999,
      postagePence: null,
      officialRrpPence: null,
      productType: "elite_trainer_box",
      canonicalKey: "elite_trainer_box:perfect-order",
      stockStatus: "in_stock",
      stockConfidence: 0.99,
      stockQuantity: null,
      evidence: [{ kind: "official_store_price", value: "5999" }],
    }],
    now: 1_800_000_000,
  });
  assert.equal(store.state.products.length, 1);
  assert.equal(store.state.products[0].officialRrpPence, null);
  assert.equal(store.state.products[0].rrpSource, null);
  assert.equal(store.state.offers[0].rrpPence, null);
});

test("explicit official RRP and GTIN propagate when intentionally supplied", async () => {
  const store = memoryStore();
  await processRetailerProducts({
    retailer: { id: "official-store", name: "Official Store", tcg: "pokemon", officialRrpSource: true },
    store,
    rawProducts: [{
      retailerSku: "SKU-2",
      title: "Perfect Order Elite Trainer Box",
      url: "https://official.example/product/sku-2",
      pricePence: 5999,
      officialRrpPence: 4999,
      gtin: "0820650857980",
      productType: "elite_trainer_box",
      canonicalKey: "elite_trainer_box:perfect-order",
      stockStatus: "in_stock",
      stockConfidence: 0.99,
      evidence: [{ kind: "explicit_rrp", value: "4999" }],
    }],
    now: 1_800_000_001,
  });
  assert.equal(store.state.products[0].officialRrpPence, 4999);
  assert.equal(store.state.products[0].rrpSource, "official-store");
  assert.equal(store.state.offers[0].gtin, "0820650857980");
});
