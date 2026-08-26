import test from "node:test";
import assert from "node:assert/strict";
import { defaultRetailerRegistryEnabled } from "../src/config/env.mjs";

test("retailer registry defaults on only for production Postgres with a database", () => {
  assert.equal(defaultRetailerRegistryEnabled({
    railwayEnvironmentName: "production",
    store: "postgres",
    databaseUrl: "postgresql://example",
  }), true);
  assert.equal(defaultRetailerRegistryEnabled({
    railwayEnvironmentName: "staging",
    store: "postgres",
    databaseUrl: "postgresql://example",
  }), false);
  assert.equal(defaultRetailerRegistryEnabled({
    railwayEnvironmentName: "production",
    store: "file",
    databaseUrl: "postgresql://example",
  }), false);
  assert.equal(defaultRetailerRegistryEnabled({
    railwayEnvironmentName: "production",
    store: "postgres",
    databaseUrl: "",
  }), false);
});
