import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapAsmodeeRrp } from "../src/rrp/asmodee-bootstrap.mjs";

function storeWithCount(count) {
  return {
    async pool() {
      return {
        async query(sql) {
          assert.match(sql, /rrp_source='asmodee-uk'/);
          return { rows: [{ count }] };
        },
      };
    },
  };
}

test("Asmodee bootstrap runs the authoritative sync when production has no Asmodee RRP", async () => {
  let calls = 0;
  const outcome = await bootstrapAsmodeeRrp({
    store: storeWithCount(0),
    databaseUrl: "postgres://example",
    syncFn: async ({ databaseUrl }) => {
      calls += 1;
      assert.equal(databaseUrl, "postgres://example");
      return { source: "asmodee-uk", matched: 4 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.result.matched, 4);
});

test("Asmodee bootstrap does not crawl again after authoritative rows exist", async () => {
  let calls = 0;
  const outcome = await bootstrapAsmodeeRrp({
    store: storeWithCount(3),
    databaseUrl: "postgres://example",
    syncFn: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.deepEqual(outcome, { skipped: true, reason: "already_bootstrapped", existing: 3 });
});

test("Asmodee bootstrap stays inert without a persistent production database", async () => {
  assert.deepEqual(await bootstrapAsmodeeRrp({ store: {}, databaseUrl: "" }), { skipped: true, reason: "database_not_configured" });
  assert.deepEqual(await bootstrapAsmodeeRrp({ store: {}, databaseUrl: "postgres://example" }), { skipped: true, reason: "persistent_store_not_available" });
});
