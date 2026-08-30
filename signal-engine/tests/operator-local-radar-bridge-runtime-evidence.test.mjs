import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATOR_LOCAL_RADAR_BRIDGE_CONTRACT_VERSION,
  operatorLocalRadarBridgeConfig,
  probeOperatorLocalRadarBridge,
} from "../src/encounters/operator-local-radar-bridge-health.mjs";

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("production bridge evidence distinguishes a missing secret without exposing it", async () => {
  const oldEnvironment = process.env.RAILWAY_ENVIRONMENT_NAME;
  const oldUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  const oldSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;
  let fetchCalls = 0;
  try {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    delete process.env.FATEDROP_METRICS_INGEST_SECRET;

    const config = operatorLocalRadarBridgeConfig();
    assert.equal(OPERATOR_LOCAL_RADAR_BRIDGE_CONTRACT_VERSION, 2);
    assert.equal(config.contractVersion, 2);
    assert.equal(config.snapshotUrl, "https://fatedrop.co.uk");
    assert.equal(config.urlSource, "production_default");
    assert.equal(config.secretConfigured, false);
    assert.equal(config.configured, false);

    const result = await probeOperatorLocalRadarBridge(async () => {
      fetchCalls += 1;
      throw new Error("missing-secret probe must fail closed before network access");
    });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result, { configured: false, reachable: false, status: "missing_secret" });
    assert.equal(JSON.stringify(result).includes("FATEDROP_METRICS_INGEST_SECRET"), false);
  } finally {
    restore("RAILWAY_ENVIRONMENT_NAME", oldEnvironment);
    restore("FATEDROP_WEBSITE_SNAPSHOT_URL", oldUrl);
    restore("FATEDROP_METRICS_INGEST_SECRET", oldSecret);
  }
});

test("configured production bridge still probes the authenticated Web readiness boundary", async () => {
  const oldEnvironment = process.env.RAILWAY_ENVIRONMENT_NAME;
  const oldUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  const oldSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;
  let request = null;
  try {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    process.env.FATEDROP_METRICS_INGEST_SECRET = "runtime-test-secret";

    const result = await probeOperatorLocalRadarBridge(async (url, options) => {
      request = { url: String(url), options };
      return new Response(null, { status: 204 });
    });

    assert.deepEqual(result, { configured: true, reachable: true, status: "ready" });
    assert.equal(request.url, "https://fatedrop.co.uk/api/dashboard/local-radar-operator-alert");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers.Authorization, "Bearer runtime-test-secret");
  } finally {
    restore("RAILWAY_ENVIRONMENT_NAME", oldEnvironment);
    restore("FATEDROP_WEBSITE_SNAPSHOT_URL", oldUrl);
    restore("FATEDROP_METRICS_INGEST_SECRET", oldSecret);
  }
});
