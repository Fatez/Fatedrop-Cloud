import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { defaultHostedFateFindEnabled } from "../src/config/env.mjs";

const envSource = fs.readFileSync(new URL("../src/config/env.mjs", import.meta.url), "utf8");

test("hosted FateFind defaults on only for Railway production with persistent Postgres", () => {
  assert.equal(defaultHostedFateFindEnabled({ railwayEnvironmentName: "production", store: "postgres", databaseUrl: "postgres://example" }), true);
  assert.equal(defaultHostedFateFindEnabled({ railwayEnvironmentName: "staging", store: "postgres", databaseUrl: "postgres://example" }), false);
  assert.equal(defaultHostedFateFindEnabled({ railwayEnvironmentName: "production", store: "file", databaseUrl: "postgres://example" }), false);
  assert.equal(defaultHostedFateFindEnabled({ railwayEnvironmentName: "production", store: "postgres", databaseUrl: "" }), false);
  assert.equal(defaultHostedFateFindEnabled({ railwayEnvironmentName: "", store: "postgres", databaseUrl: "postgres://example" }), false);
});

test("explicit Railway feature flag remains the authoritative kill switch", () => {
  assert.match(envSource, /enabled:\s*bool\("FATEDROP_HOSTED_FATEFIND_ENABLED", hostedFateFindProductionDefault\)/);
  assert.match(envSource, /explicitlyConfigured:\s*hostedFateFindExplicitlyConfigured/);
  assert.match(envSource, /RAILWAY_ENVIRONMENT_NAME/);
});
