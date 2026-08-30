import test from "node:test";
import assert from "node:assert/strict";
import { processRetailerProducts } from "../src/core/engine.mjs";

const retailer = {
  id: "delta-test",
  name: "Delta Test",
  tcg: "pokemon",
  officialRrpSource: false,
};

function raw({ stockStatus = "in_stock", pricePence = 4999, stockQuantity = 3 } = {}) {
  return {
    retailerSku: "SKU-1",
    title: "Pokemon TCG Test Elite Trainer Box",
    url: "https://example.test/products/sku-1",
    imageUrl: null,
    pricePence,
    postagePence: null,
    officialRrpPence: null,
    gtin: null,
    productType: "elite_trainer_box",
    canonicalKey: "pokemon tcg test elite trainer box",
    stockStatus,
    stockConfidence: 1,
    stockQuantity,
    evidence: [{ kind: "test", value: "fixture" }],
  };
}

function storeWith(previousOffer) {
  const saved = [];
  return {
    saved,
    isBaselineComplete: async () => true,
    getProduct: async () => null,
    getOffer: async () => previousOffer,
    saveScan: async (payload) => saved.push(payload),
  };
}

test("unchanged retailer SKU state does not create another stock observation", async () => {
  const previousOffer = {
    offerId: "ignored-by-fixture",
    stockStatus: "in_stock",
    pricePence: 4999,
    stockQuantity: 3,
    evidence: [{ kind: "test", value: "fixture" }],
    everAvailableAt: 1,
    firstSeenAt: 1,
  };
  const store = storeWith(previousOffer);
  await processRetailerProducts({ retailer, store, rawProducts: [raw()], now: 100, dispatchNotifications: false });
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].observations.length, 0);
});

test("stock, price or quantity deltas still persist an observation", async () => {
  const previousOffer = {
    offerId: "ignored-by-fixture",
    stockStatus: "out_of_stock",
    pricePence: 4999,
    stockQuantity: 0,
    evidence: [{ kind: "test", value: "fixture" }],
    everAvailableAt: null,
    firstSeenAt: 1,
  };
  const store = storeWith(previousOffer);
  await processRetailerProducts({ retailer, store, rawProducts: [raw({ stockStatus: "in_stock", stockQuantity: 2 })], now: 101, dispatchNotifications: false });
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].observations.length, 1);
  assert.equal(store.saved[0].observations[0].stockStatus, "in_stock");
});
