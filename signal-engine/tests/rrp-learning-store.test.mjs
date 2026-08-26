import test from "node:test";
import assert from "node:assert/strict";
import { recordUnresolvedRrp } from "../src/stores/rrp-learning-store.mjs";

test("unresolved RRP upsert increments recurrence rather than duplicating", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ occurrence_count: 2 }] };
    },
  };
  const row = await recordUnresolvedRrp(pool, {
    id: "rrpq-1", tcg: "pokemon", retailerId: "magic-madhouse", observedTitle: "SWSH Silver Tempest Booster Box",
    productType: "booster_box", failureReason: "no_verified_rrp_reference", observedAt: 123, evidence: {},
  });
  assert.equal(row.occurrence_count, 2);
  assert.match(calls[0].sql, /occurrence_count=fatedrop_rrp_resolution_queue\.occurrence_count \+ 1/);
});
