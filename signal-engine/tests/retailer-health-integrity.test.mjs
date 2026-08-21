import test from "node:test";
import assert from "node:assert/strict";
import { scanRetailer } from "../src/core/engine.mjs";
import { ADAPTER_TYPES } from "../src/retailers/registry.mjs";

test("browser collectors are skipped by the generic scheduler without poisoning health", async () => {
  let sourceCalls = 0;
  let failureCalls = 0;
  const retailer = {
    id: "pokemon-center-uk",
    name: "Pokémon Center UK",
    adapterType: ADAPTER_TYPES.BROWSER_COLLECTOR,
  };
  const store = {
    async recordFailure() { failureCalls += 1; },
  };

  const result = await scanRetailer({
    retailer,
    store,
    scanSource: async () => {
      sourceCalls += 1;
      throw new Error("should not run");
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "external_collector");
  assert.equal(result.signalsCreated, 0);
  assert.equal(sourceCalls, 0);
  assert.equal(failureCalls, 0);
});

test("zero-product catalogue scans are unhealthy and preserve the previous catalogue", async () => {
  const failures = [];
  let saveCalls = 0;
  const retailer = {
    id: "example-retailer",
    name: "Example Retailer",
    adapterType: ADAPTER_TYPES.GENERIC_HTML,
  };
  const store = {
    async recordFailure(_retailer, error) { failures.push(String(error?.message || error)); },
    async saveScan() { saveCalls += 1; },
  };

  const result = await scanRetailer({
    retailer,
    store,
    scanSource: async () => ({ products: [], pages: [{ status: 200 }, { status: 200 }] }),
  });

  assert.equal(result.productsSeen, 0);
  assert.equal(result.pagesScanned, 2);
  assert.equal(result.signalsCreated, 0);
  assert.match(result.error, /zero qualifying products/i);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /preserving last valid catalogue/i);
  assert.equal(saveCalls, 0);
});
