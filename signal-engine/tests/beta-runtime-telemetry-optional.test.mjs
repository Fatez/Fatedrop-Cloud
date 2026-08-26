import test from "node:test";
import assert from "node:assert/strict";
import { summarizeBetaRuntimeReadiness, summarizeSignalNetworkReadiness } from "../src/telemetry/beta-runtime-readiness.mjs";

const discord = { ready: true };
const network = summarizeSignalNetworkReadiness([
  { id: "one", healthy: true, stale: false, baselineCompleted: true, lastSuccessAt: 1_787_780_000 },
  { id: "two", healthy: true, stale: false, baselineCompleted: true, lastSuccessAt: 1_787_780_000 },
  { id: "three", healthy: true, stale: false, baselineCompleted: true, lastSuccessAt: 1_787_780_000 },
]);
const hostedFateFind = {
  enabled: true,
  configured: true,
  eligibleFinds: 1,
  webReadyFinds: 1,
  notificationReadiness: { ready: true },
};

test("an unconfigured telemetry-only Web mirror does not block canonical beta readiness", () => {
  const result = summarizeBetaRuntimeReadiness({
    discord,
    signalNetwork: network,
    hostedFateFind,
    websiteSnapshot: {
      ready: false,
      configured: false,
      urlConfigured: false,
      secretConfigured: false,
      reason: "not_configured",
    },
  });

  assert.equal(result.infrastructureReady, true);
  assert.equal(result.signalNetworkReady, true);
  assert.equal(result.ready, true);
  assert.equal(result.websiteSnapshot.ready, false);
  assert.equal(result.websiteSnapshot.reason, "not_configured");
});

test("a configured but unhealthy telemetry mirror remains a release warning", () => {
  const result = summarizeBetaRuntimeReadiness({
    discord,
    signalNetwork: network,
    hostedFateFind,
    websiteSnapshot: {
      ready: false,
      configured: true,
      urlConfigured: true,
      secretConfigured: true,
      reason: "stale",
    },
  });

  assert.equal(result.infrastructureReady, false);
  assert.equal(result.ready, false);
});