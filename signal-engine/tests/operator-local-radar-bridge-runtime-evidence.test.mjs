import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const moduleHref = new URL("../src/encounters/operator-local-radar-bridge-health.mjs", import.meta.url).href;

function runIsolated(script, overrides) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      RAILWAY_ENVIRONMENT_NAME: "production",
      FATEDROP_WEBSITE_SNAPSHOT_URL: "",
      FATEDROP_METRICS_INGEST_SECRET: "",
      FATEDROP_TEST_MODULE_HREF: moduleHref,
      ...overrides,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test("production bridge evidence distinguishes a missing secret without exposing it", () => {
  const evidence = runIsolated(`
    const mod = await import(process.env.FATEDROP_TEST_MODULE_HREF);
    let fetchCalls = 0;
    const config = mod.operatorLocalRadarBridgeConfig();
    const probe = await mod.probeOperatorLocalRadarBridge(async () => {
      fetchCalls += 1;
      throw new Error("missing-secret probe must fail closed before network access");
    });
    console.log(JSON.stringify({
      version: mod.OPERATOR_LOCAL_RADAR_BRIDGE_CONTRACT_VERSION,
      contractVersion: config.contractVersion,
      snapshotUrl: config.snapshotUrl,
      urlSource: config.urlSource,
      secretConfigured: config.secretConfigured,
      configured: config.configured,
      fetchCalls,
      probe,
    }));
  `, {});

  assert.equal(evidence.version, 2);
  assert.equal(evidence.contractVersion, 2);
  assert.equal(evidence.snapshotUrl, "https://fatedrop.co.uk");
  assert.equal(evidence.urlSource, "production_default");
  assert.equal(evidence.secretConfigured, false);
  assert.equal(evidence.configured, false);
  assert.equal(evidence.fetchCalls, 0);
  assert.deepEqual(evidence.probe, { configured: false, reachable: false, status: "missing_secret" });
  assert.equal(JSON.stringify(evidence).includes("FATEDROP_METRICS_INGEST_SECRET"), false);
});

test("configured production bridge still probes the authenticated Web readiness boundary", () => {
  const evidence = runIsolated(`
    const mod = await import(process.env.FATEDROP_TEST_MODULE_HREF);
    let request = null;
    const probe = await mod.probeOperatorLocalRadarBridge(async (url, options) => {
      request = {
        url: String(url),
        method: options.method,
        authorization: options.headers.Authorization,
      };
      return new Response(null, { status: 204 });
    });
    console.log(JSON.stringify({ probe, request }));
  `, { FATEDROP_METRICS_INGEST_SECRET: "runtime-test-secret" });

  assert.deepEqual(evidence.probe, { configured: true, reachable: true, status: "ready" });
  assert.equal(evidence.request.url, "https://fatedrop.co.uk/api/dashboard/local-radar-operator-alert");
  assert.equal(evidence.request.method, "GET");
  assert.equal(evidence.request.authorization, "Bearer runtime-test-secret");
});
