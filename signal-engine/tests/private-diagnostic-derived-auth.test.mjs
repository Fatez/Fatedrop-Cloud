import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { derivedSignalApiToken } from "../src/config/env.mjs";

const context = "fatedrop:private-diagnostics:v1";

test("dedicated Signal API token remains authoritative when configured", () => {
  assert.equal(derivedSignalApiToken({
    signalApiToken: "dedicated-token",
    metricsIngestSecret: "shared-metrics-secret",
  }), "dedicated-token");
});

test("private diagnostic token derives deterministically from the existing metrics secret", () => {
  const shared = "shared-metrics-secret";
  const expected = createHmac("sha256", shared).update(context).digest("hex");
  assert.equal(derivedSignalApiToken({ metricsIngestSecret: shared }), expected);
});

test("private diagnostics remain fail-closed without either credential", () => {
  assert.equal(derivedSignalApiToken(), "");
  assert.equal(derivedSignalApiToken({ signalApiToken: "  ", metricsIngestSecret: "  " }), "");
});
