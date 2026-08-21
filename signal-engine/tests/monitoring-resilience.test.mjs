import test from "node:test";
import assert from "node:assert/strict";
import { scanRetailer } from "../src/core/engine.mjs";

const retailer = {
  id: "test-retailer",
  name: "Test Retailer",
  tcg: "pokemon",
  adapterType: "shopify",
};

test("scanRetailer skips cleanly when another worker holds the retailer scan lock", async () => {
  let scanCalled = false;
  const store = {
    async withRetailerScanLock() { return { acquired: false, value: null }; },
    async recordFailure() { throw new Error("recordFailure should not be called for a healthy lock skip"); },
  };

  const result = await scanRetailer({
    retailer,
    store,
    scanSource: async () => { scanCalled = true; return { products: [] }; },
  });

  assert.equal(scanCalled, false);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "scan_in_progress");
  assert.equal(result.signalsCreated, 0);
});

test("scanRetailer executes inside the retailer lock when acquired", async () => {
  let lockEntered = false;
  let saved = null;
  const store = {
    async withRetailerScanLock(_retailerId, work) {
      lockEntered = true;
      return { acquired: true, value: await work() };
    },
    async isBaselineComplete() { return true; },
    async getProduct() { return null; },
    async getOffer() { return null; },
    async saveScan(payload) { saved = payload; },
    async recordFailure() {},
  };

  const result = await scanRetailer({
    retailer,
    store,
    dispatchNotifications: false,
    scanSource: async () => ({
      pages: ["page-1"],
      products: [{
        retailerSku: "sku-1",
        title: "Test Elite Trainer Box",
        url: "https://example.test/product",
        imageUrl: null,
        pricePence: 4999,
        postagePence: null,
        officialRrpPence: null,
        gtin: null,
        productType: "elite_trainer_box",
        canonicalKey: "test-elite-trainer-box",
        stockStatus: "in_stock",
        stockConfidence: 1,
        stockQuantity: 1,
        evidence: [{ kind: "test", value: "unit" }],
      }],
    }),
  });

  assert.equal(lockEntered, true);
  assert.equal(saved.retailer.id, retailer.id);
  assert.equal(result.productsSeen, 1);
  assert.equal(result.pagesScanned, 1);
  assert.equal(result.discord.deferred, true);
});
