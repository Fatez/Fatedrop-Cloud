import test from "node:test";
import assert from "node:assert/strict";

import { preloadPreviousState } from "../src/core/previous-state.mjs";
import { recordRetailerRunFinish, recordRetailerRunStart } from "../src/telemetry/retailer-runs.mjs";

test("previous retailer state is loaded in two bulk queries", async () => {
  const queries = [];
  const store = {
    async pool() {
      return {
        async query(sql, values) {
          queries.push({ sql, values });
          if (sql.includes("fatedrop_products")) {
            return { rows: [{ id: "p1", canonical_key: "k1", title: "One", product_type: "sealed", tcg: "pokemon", official_rrp_pence: 4999, rrp_source: "pokemon-center-uk", rrp_observed_at: 100, first_seen_at: 90, updated_at: 100 }] };
          }
          return { rows: [{ offer_id: "o1", product_id: "p1", retailer_id: "r1", retailer_name: "Retailer", retailer_sku: "sku", title: "One", url: "https://example.test/one", image_url: null, price_pence: 4999, postage_pence: null, gtin: null, stock_status: "in_stock", stock_confidence: 1, stock_quantity: 1, ever_available_at: 90, first_seen_at: 90, last_seen_at: 100 }] };
        },
      };
    },
  };

  const state = await preloadPreviousState(store, [
    { productId: "p1", offerId: "o1" },
    { productId: "p1", offerId: "o1" },
  ]);

  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].values[0], ["p1"]);
  assert.deepEqual(queries[1].values[0], ["o1"]);
  assert.equal(state.products.get("p1").officialRrpPence, 4999);
  assert.equal(state.offers.get("o1").stockStatus, "in_stock");
});

test("retailer run telemetry records start and finish without schema changes", async () => {
  const queries = [];
  const store = { async pool() { return { async query(sql, values) { queries.push({ sql, values }); return { rows: [] }; } }; } };

  await recordRetailerRunStart(store, { runId: "run-1", retailerId: "retailer-1", startedAt: 100 });
  await recordRetailerRunFinish(store, { runId: "run-1", completedAt: 105, status: "success", pagesScanned: 3, productsObserved: 402, catalogueComplete: true, diagnostics: { signalsCreated: 2 } });

  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /fatedrop_retailer_monitor_runs/);
  assert.match(queries[1].sql, /UPDATE fatedrop_retailer_monitor_runs/);
  assert.equal(queries[1].values[2], "success");
  assert.equal(queries[1].values[4], 402);
});
