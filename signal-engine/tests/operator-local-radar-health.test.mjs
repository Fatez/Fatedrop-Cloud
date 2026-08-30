import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const intake = fs.readFileSync(new URL("../src/encounters/operator-local-radar-intake.mjs", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../src/encounters/operator-local-radar-bridge-health.mjs", import.meta.url), "utf8");
const publicContract = fs.readFileSync(new URL("../src/telemetry/public-signal-contract.mjs", import.meta.url), "utf8");

test("operator intake records a redacted heartbeat without changing alert truth", () => {
  assert.match(intake, /export function getOperatorLocalRadarHealth\(\)/);
  assert.match(intake, /lastPollCompletedAt/);
  assert.match(intake, /lastStatus = bridge\.reachable \? "ok" : "bridge_unavailable"/);
  assert.match(intake, /lastErrorCode = bridge\.reachable \? null : `bridge_\$\{bridge\.status\}`/);
  assert.match(intake, /issuesSeen = issues\.length/);
  assert.match(intake, /published = results\.filter/);
  assert.match(intake, /held = results\.filter/);
  assert.match(intake, /retry = results\.filter/);
  assert.match(intake, /invalid = results\.filter/);
  assert.match(intake, /webBridgeConfigured/);
  assert.match(intake, /canonicalStoreConfigured/);
  assert.match(intake, /reconcileCuratedIncomingIntel/);
  assert.match(intake, /unmatchedTargets/);
});

test("production watcher probes the exact Web operator route without sending an alert", () => {
  assert.match(intake, /RAILWAY_ENVIRONMENT_NAME === "production"/);
  assert.match(intake, /probeOperatorLocalRadarBridge\(\)/);
  assert.match(bridge, /method: "GET"/);
  assert.match(bridge, /\/api\/dashboard\/local-radar-operator-alert/);
  assert.match(bridge, /Authorization: `Bearer \$\{secret\}`/);
  assert.match(bridge, /response\.status === 204/);
  assert.doesNotMatch(bridge, /method: "POST"/);
  assert.doesNotMatch(bridge, /body:/);
});

test("public Signal summary exposes only aggregate operator health", () => {
  assert.match(publicContract, /localRadarOperator: safeOperatorHealth\(\)/);
  assert.match(publicContract, /available: health\.started === true/);
  assert.match(publicContract, /canonicalStoreConfigured: health\.canonicalStoreConfigured === true/);
  assert.match(publicContract, /webBridgeConfigured: health\.webBridgeConfigured === true/);
  assert.match(publicContract, /issuesSeen: safeCount\(health\.issuesSeen\)/);
  assert.match(publicContract, /published: safeCount\(health\.published\)/);
  assert.match(publicContract, /held: safeCount\(health\.held\)/);
  assert.match(publicContract, /retry: safeCount\(health\.retry\)/);
  assert.match(publicContract, /invalid: safeCount\(health\.invalid\)/);

  for (const forbidden of [
    "targetBranches",
    "rawProductTitle",
    "sourceUrl",
    "retailerName",
    "productTitle",
    "eventId",
    "operatorIssue",
  ]) {
    const safeFunction = publicContract.slice(publicContract.indexOf("function safeOperatorHealth"));
    assert.doesNotMatch(safeFunction, new RegExp(forbidden));
  }
});
