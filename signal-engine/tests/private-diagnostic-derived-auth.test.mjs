import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { derivedSignalApiToken, privateDiagnosticApiTokens } from "../src/config/env.mjs";

const context = "fatedrop:private-diagnostics:v1";

test("dedicated Signal API token remains authoritative for legacy single-token consumers", () => {
  assert.equal(derivedSignalApiToken({
    signalApiToken: "dedicated-token",
    metricsIngestSecret: "shared-metrics-secret",
  }), "dedicated-token");
});

test("private diagnostics expose both dedicated and scoped derived credentials when both exist", () => {
  const shared = "shared-metrics-secret";
  const expectedDerived = createHmac("sha256", shared).update(context).digest("hex");
  assert.deepEqual(privateDiagnosticApiTokens({
    signalApiToken: "dedicated-token",
    metricsIngestSecret: shared,
  }), ["dedicated-token", expectedDerived]);
});

test("private diagnostic token derives deterministically from the existing metrics secret", () => {
  const shared = "shared-metrics-secret";
  const expected = createHmac("sha256", shared).update(context).digest("hex");
  assert.equal(derivedSignalApiToken({ metricsIngestSecret: shared }), expected);
  assert.deepEqual(privateDiagnosticApiTokens({ metricsIngestSecret: shared }), [expected]);
});

test("duplicate credentials are deduplicated and private diagnostics remain fail-closed without credentials", () => {
  assert.deepEqual(privateDiagnosticApiTokens(), []);
  assert.deepEqual(privateDiagnosticApiTokens({ signalApiToken: "  ", metricsIngestSecret: "  " }), []);
  assert.equal(derivedSignalApiToken(), "");
});
