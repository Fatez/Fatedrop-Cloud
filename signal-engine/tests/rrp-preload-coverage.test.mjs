import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const postgresStore = fs.readFileSync(new URL("../src/stores/postgres-store.mjs", import.meta.url), "utf8");

test("bounded product preload prioritises verified RRP rows before recency", () => {
  assert.match(postgresStore, /ORDER BY \(official_rrp_pence IS NOT NULL AND rrp_source IS NOT NULL\) DESC, updated_at DESC LIMIT \$1/);
  assert.match(postgresStore, /Math\.min\(5000, Math\.max\(1, limit\)\)/);
});
