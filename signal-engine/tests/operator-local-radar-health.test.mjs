import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { operatorLocalRadarBridgeConfig } from "../src/encounters/operator-local-radar-bridge-health.mjs";

const intake = fs.readFileSync(new URL("../src/encounters/operator-local-radar-intake.mjs", import.meta.url), "utf8");
const bridge = fs.readFileSync(new URL("../src/encounters/operator-local-radar-bridge-health.mjs", import.meta.url), "utf8");
const publicContract = fs.readFileSync(new URL("../src/telemetry/public-signal-contract.mjs", import.meta.url), "utf8");
const productionMonitor = fs.readFileSync(new URL("../../.github/workflows/monitor-local-radar-operator-production.yml", import.meta.url), "utf8");

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
  assert.match(intake, /githubAuthenticated/);
  assert.match(intake, /canonicalStoreConfigured/);
  assert.match(intake, /reconcileCuratedIncomingIntel/);
  assert.match(intake, /unmatchedTargets/);
});

test("production watcher probes the exact Web operator route without sending an alert", () => {
  assert.match(intake, /RAILWAY_ENVIRONMENT_NAME === "production"/);
  assert.match(intake, /probeOperatorLocalRadarBridge\(\)/);
  assert.match(bridge, /method: "GET"/);
  assert.match(bridge, /\/api\/dashboard\/local-radar-operator-alert/);
  assert.match(bridge, /Authorization: `Bearer \$\{config\.secret\}`/);
  assert.match(bridge, /response\.status === 204/);
  assert.match(bridge, /status: "missing_url"/);
  assert.match(bridge, /status: "missing_secret"/);
  assert.match(bridge, /status: "unauthorized"/);
  assert.match(bridge, /status: "push_unhealthy"/);
  assert.match(bridge, /status: "unreachable"/);
  assert.doesNotMatch(bridge, /method: "POST"/);
  assert.doesNotMatch(bridge, /body:/);
});

test("production Web origin may default safely but the shared secret remains mandatory", () => {
  const original = {
    railway: process.env.RAILWAY_ENVIRONMENT_NAME,
    website: process.env.FATEDROP_WEBSITE_SNAPSHOT_URL,
    secret: process.env.FATEDROP_METRICS_INGEST_SECRET,
  };
  try {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    process.env.FATEDROP_METRICS_INGEST_SECRET = "test-only-secret";
    const configured = operatorLocalRadarBridgeConfig();
    assert.equal(configured.contractVersion, 2);
    assert.equal(configured.snapshotUrl, "https://fatedrop.co.uk");
    assert.equal(configured.urlSource, "production_default");
    assert.equal(configured.secretConfigured, true);
    assert.equal(configured.configured, true);

    delete process.env.FATEDROP_METRICS_INGEST_SECRET;
    const missingSecret = operatorLocalRadarBridgeConfig();
    assert.equal(missingSecret.contractVersion, 2);
    assert.equal(missingSecret.snapshotUrl, "https://fatedrop.co.uk");
    assert.equal(missingSecret.urlSource, "production_default");
    assert.equal(missingSecret.secretConfigured, false);
    assert.equal(missingSecret.configured, false);
  } finally {
    if (original.railway === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
    else process.env.RAILWAY_ENVIRONMENT_NAME = original.railway;
    if (original.website === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = original.website;
    if (original.secret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
    else process.env.FATEDROP_METRICS_INGEST_SECRET = original.secret;
  }
});

test("public Signal summary exposes only aggregate operator health", () => {
  assert.match(publicContract, /localRadarOperator: safeOperatorHealth\(\)/);
  assert.match(publicContract, /available: health\.started === true/);
  assert.match(publicContract, /canonicalStoreConfigured: health\.canonicalStoreConfigured === true/);
  assert.match(publicContract, /webBridgeConfigured: health\.webBridgeConfigured === true/);
  assert.match(publicContract, /githubAuthenticated: health\.githubAuthenticated === true/);
  assert.match(publicContract, /&& health\.githubAuthenticated === true/);
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

test("production operator monitor is read-only and checks only redacted public health", () => {
  assert.match(productionMonitor, /https:\/\/fatedrop-cloud-production\.up\.railway\.app\/api\/signal-summary/);
  assert.match(productionMonitor, /localRadarOperator/);
  assert.match(productionMonitor, /health\.available === true/);
  assert.match(productionMonitor, /health\.status === 'ok'/);
  assert.match(productionMonitor, /health\.canonicalStoreConfigured === true/);
  assert.match(productionMonitor, /health\.webBridgeConfigured === true/);
  assert.match(productionMonitor, /health\.githubAuthenticated === true/);
  assert.doesNotMatch(productionMonitor, /^\s*pull_request:/m);
  assert.doesNotMatch(productionMonitor, /local-radar-operator-alert/);
  assert.doesNotMatch(productionMonitor, /method:.*POST/i);
  assert.doesNotMatch(productionMonitor, /-X\s+POST/i);
  assert.doesNotMatch(productionMonitor, /Authorization:/i);
  assert.doesNotMatch(productionMonitor, /issues\/|create_issue|graphql/i);
});
