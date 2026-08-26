import test from "node:test";
import assert from "node:assert/strict";
import { rememberUnresolvedRrp } from "../src/core/rrp-learning-runtime.mjs";

test("runtime queues unresolved mainstream sealed product", async () => {
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql, params }); return { rows: [{ id: "x" }] }; } };
  const store = { async pool() { return pool; } };
  const row = await rememberUnresolvedRrp({
    store,
    product: { id: "prd-1", tcg: "pokemon", productType: "booster_box" },
    offer: { offerId: "off-1", retailerId: "magic-madhouse", title: "SWSH Silver Tempest Booster Box", productType: "booster_box" },
    retailer: { id: "magic-madhouse" },
    observedAt: 123,
  });
  assert.equal(row.id, "x");
  assert.equal(queries.length, 1);
});
