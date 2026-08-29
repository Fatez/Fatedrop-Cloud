import test from "node:test";
import assert from "node:assert/strict";
import { assertProductionDatabaseTarget, databaseNameFromUrl } from "../src/stores/database-target.mjs";

test("database target parser reads the explicit Neon database name", () => {
  assert.equal(databaseNameFromUrl("postgresql://user:pass@example.neon.tech/neondb?sslmode=require"), "neondb");
});

test("database target guard is inert outside Railway production", () => {
  assert.deepEqual(assertProductionDatabaseTarget("postgresql://user:pass@example.neon.tech/not-production", {
    railwayEnvironmentName: "staging",
    expectedDatabaseName: "neondb",
  }), {
    checked: false,
    actualDatabaseName: "not-production",
    expectedDatabaseName: "neondb",
  });
});

test("database target guard accepts the canonical production database", () => {
  assert.deepEqual(assertProductionDatabaseTarget("postgresql://user:pass@example.neon.tech/neondb?sslmode=require", {
    railwayEnvironmentName: "production",
    expectedDatabaseName: "neondb",
  }), {
    checked: true,
    actualDatabaseName: "neondb",
    expectedDatabaseName: "neondb",
  });
});

test("database target guard fails closed on a wrong production database", () => {
  assert.throws(() => assertProductionDatabaseTarget("postgresql://user:pass@example.neon.tech/postgres", {
    railwayEnvironmentName: "production",
    expectedDatabaseName: "neondb",
  }), /must target "neondb", received "postgres"/);
});

test("database target guard rejects production URLs without an explicit database", () => {
  assert.throws(() => assertProductionDatabaseTarget("postgresql://user:pass@example.neon.tech", {
    railwayEnvironmentName: "production",
    expectedDatabaseName: "neondb",
  }), /must include an explicit database name/);
});
