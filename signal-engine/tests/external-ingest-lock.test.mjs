import assert from "node:assert/strict";
import test from "node:test";

import { ingestRetailerProducts } from "../src/core/engine.mjs";

const retailer = {
  id: "pokemon-center-uk",
  name: "Pokémon Center UK",
  tcg: "pokemon",
};

const products = [{
  retailerSku: "pcuk-lock-test",
  title: "Pokémon TCG Lock Test",
  url: "https://example.test/products/pcuk-lock-test",
  stockStatus: "out_of_stock",
  stockConfidence: 1,
  pricePence: 4999,
}];

test("external ingest refuses an overlapping retailer ingest before deriving signals", async () => {
  let lockCalls = 0;
  let workCalled = false;
  const store = {
    async withRetailerScanLock(retailerId, work) {
      lockCalls += 1;
      assert.equal(retailerId, retailer.id);
      assert.equal(typeof work, "function");
      workCalled = false;
      return { acquired: false, value: null };
    },
  };

  const result = await ingestRetailerProducts({ retailer, store, products, now: 1_787_520_000 });

  assert.equal(lockCalls, 1);
  assert.equal(workCalled, false);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, "ingest_in_progress");
  assert.equal(result.signalsCreated, 0);
});
