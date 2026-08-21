import test from "node:test";
import assert from "node:assert/strict";
import { writeAsmodeeRrpUpdates } from "../src/rrp/asmodee-authority.mjs";

function update(productId, title = productId) {
  return {
    record: { officialRrpPence: 4999 },
    product: {
      id: productId,
      tcg: "pokemon",
      canonical_key: `elite_trainer_box:${productId}`,
      title,
      product_type: "elite_trainer_box",
    },
    method: "identity",
  };
}

test("retries deadlocked Asmodee RRP transactions and preserves deterministic write order", async () => {
  const calls = [];
  let injectedDeadlock = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("UPDATE fatedrop_products") && !injectedDeadlock) {
        injectedDeadlock = true;
        const error = new Error("deadlock detected");
        error.code = "40P01";
        throw error;
      }
      return { rows: [] };
    },
  };

  await writeAsmodeeRrpUpdates(client, [update("prd_z"), update("prd_a")], 1234, {
    attempts: 3,
    sleepImpl: async () => {},
  });

  assert.equal(calls.filter((call) => call.sql === "BEGIN").length, 2);
  assert.equal(calls.filter((call) => call.sql === "ROLLBACK").length, 1);
  assert.equal(calls.filter((call) => call.sql === "COMMIT").length, 1);

  const successfulUpdateIds = calls
    .filter((call) => call.sql.startsWith("UPDATE fatedrop_products"))
    .map((call) => call.params[3])
    .slice(-2);
  assert.deepEqual(successfulUpdateIds, ["prd_a", "prd_z"]);
});

test("does not retry non-transaction database errors", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith("UPDATE fatedrop_products")) {
        const error = new Error("permission denied");
        error.code = "42501";
        throw error;
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    writeAsmodeeRrpUpdates(client, [update("prd_a")], 1234, {
      attempts: 4,
      sleepImpl: async () => {},
    }),
    /permission denied/,
  );

  assert.equal(calls.filter((sql) => sql === "BEGIN").length, 1);
  assert.equal(calls.filter((sql) => sql === "ROLLBACK").length, 1);
});
