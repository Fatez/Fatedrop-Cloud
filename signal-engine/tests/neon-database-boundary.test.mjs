import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertProductionDatabaseTarget,
  databaseNameFromUrl,
} from "../src/stores/database-target.mjs";

test("database target parser returns the explicit PostgreSQL database name", () => {
  assert.equal(databaseNameFromUrl("postgresql://user:pass@example.neon.tech/neondb?sslmode=require"), "neondb");
  assert.equal(databaseNameFromUrl("postgres://user:pass@localhost:5432/fatedrop_test"), "fatedrop_test");
  assert.equal(databaseNameFromUrl("not-a-postgres-url"), null);
});

test("production database target accepts canonical neondb and rejects database drift", () => {
  assert.deepEqual(
    assertProductionDatabaseTarget("postgresql://user:pass@example.neon.tech/neondb?sslmode=require", {
      railwayEnvironmentName: "production",
      expectedDatabaseName: "neondb",
    }),
    { checked: true, actualDatabaseName: "neondb", expectedDatabaseName: "neondb" },
  );

  assert.throws(
    () => assertProductionDatabaseTarget("postgresql://user:pass@example.neon.tech/postgres?sslmode=require", {
      railwayEnvironmentName: "production",
      expectedDatabaseName: "neondb",
    }),
    /must target "neondb", received "postgres"/,
  );
});

test("non-production environments are inspected without enforcing the production database name", () => {
  assert.deepEqual(
    assertProductionDatabaseTarget("postgresql://user:pass@localhost:5432/fatedrop_test", {
      railwayEnvironmentName: "development",
      expectedDatabaseName: "neondb",
    }),
    { checked: false, actualDatabaseName: "fatedrop_test", expectedDatabaseName: "neondb" },
  );
});

test("Cloud composition keeps one canonical store boundary and Hosted FateFind does not create its own pg Pool", async () => {
  const storeSource = await readFile(new URL("../src/stores/index.mjs", import.meta.url), "utf8");
  const hostedSource = await readFile(new URL("../src/hosted/run.mjs", import.meta.url), "utf8");

  assert.match(storeSource, /let storeInstance = null/);
  assert.match(storeSource, /if \(storeInstance && storeInstanceKey === key\) return storeInstance/);
  assert.match(hostedSource, /import \{ createStore \} from "\.\.\/stores\/index\.mjs"/);
  assert.doesNotMatch(hostedSource, /new Pool\s*\(/);
  assert.match(hostedSource, /return store\.pool\(\)/);
});
