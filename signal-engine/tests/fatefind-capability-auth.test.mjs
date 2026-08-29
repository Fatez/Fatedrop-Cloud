import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { consumeFateFindEvaluationCapability } from "../src/hosted/fatefind-capability-auth.mjs";

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("one-use FateFind capability is hashed, scoped to one watch and atomically consumed", async () => {
  const calls = [];
  const store = {
    async pool() {
      return {
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows: [{ token_hash: params[0] }] };
        },
      };
    },
  };

  const allowed = await consumeFateFindEvaluationCapability(store, {
    fateFindId: "find-123",
    token: "secret-capability",
    now: 123456,
  });

  assert.equal(allowed, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM fatedrop_fatefind_evaluation_capabilities/);
  assert.match(calls[0].sql, /fate_find_id = \$2/);
  assert.match(calls[0].sql, /expires_at >= \$3/);
  assert.match(calls[0].sql, /RETURNING token_hash/);
  assert.deepEqual(calls[0].params, [hash("secret-capability"), "find-123", 123456]);
  assert.doesNotMatch(calls[0].sql, /SELECT\s+\*/i);
});

test("missing, expired or not-yet-migrated capabilities fail closed", async () => {
  assert.equal(await consumeFateFindEvaluationCapability({}, { fateFindId: "x", token: "y" }), false);

  const missing = {
    async pool() {
      return { async query() { return { rows: [] }; } };
    },
  };
  assert.equal(await consumeFateFindEvaluationCapability(missing, { fateFindId: "x", token: "y" }), false);

  const migrationPending = {
    async pool() {
      return { async query() { const error = new Error("missing table"); error.code = "42P01"; throw error; } };
    },
  };
  assert.equal(await consumeFateFindEvaluationCapability(migrationPending, { fateFindId: "x", token: "y" }), false);
});
