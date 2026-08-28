import test from "node:test";
import assert from "node:assert/strict";
import { PostgresRetailerRegistry } from "../src/retailers/postgres-registry.mjs";

test("retailer registry reuses the canonical pool provider", async () => {
  const canonicalPool = { query() { throw new Error("query should not be called by pool ownership test"); } };
  let providerCalls = 0;
  const registry = new PostgresRetailerRegistry("postgresql://unused.example/neondb", {
    poolProvider: async () => {
      providerCalls += 1;
      return canonicalPool;
    },
  });

  assert.equal(await registry.pool(), canonicalPool);
  assert.equal(await registry.pool(), canonicalPool);
  assert.equal(providerCalls, 2);
});
