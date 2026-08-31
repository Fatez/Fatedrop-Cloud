import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOperatorNotification,
  parseOperatorIssue,
  processOperatorIssue,
} from "../src/encounters/operator-local-radar-intake.mjs";

const NOW = Date.parse("2026-08-29T01:00:00+01:00");

function operatorIssue(overrides = {}) {
  const body = {
    schemaVersion: 1,
    retailerId: "entertainer-uk",
    retailerName: "The Entertainer",
    rawProductTitle: "Pokémon TCG: TEST Local Radar Incoming Stock",
    kind: "echo",
    sourceType: "official_retailer_page",
    sourceUrl: "https://www.thetoyshop.com/pokemon-at-the-entertainer",
    sourceLabel: "The Entertainer official Pokémon TCG page",
    expectedFrom: "2026-08-30T00:00:00+01:00",
    expectedTo: "2026-08-30T23:59:59+01:00",
    expectedLabel: "Expected 30 August",
    notificationDateLabel: "tomorrow, 30 August",
    expiresAt: "2026-08-31T23:59:59+01:00",
    confidence: 0.68,
    targetBranches: [
      "The Entertainer Bromley Lower Mall",
      "The Entertainer Watford",
    ],
    ...overrides.body,
  };
  return {
    number: 301,
    state: "open",
    title: "[FATEDROP LOCAL RADAR] TEST incoming stock",
    body: JSON.stringify(body),
    created_at: "2026-08-29T00:55:00+01:00",
    updated_at: "2026-08-29T00:55:00+01:00",
    user: { login: "Fatez" },
    ...overrides,
    body: JSON.stringify(body),
  };
}

test("authorised official preparation evidence remains advisory Echo and builds descriptive copy", () => {
  const parsed = parseOperatorIssue(operatorIssue(), NOW);
  assert.equal(parsed.entry.kind, "echo");
  assert.equal(parsed.entry.confidence, 0.68);
  const notification = buildOperatorNotification(parsed, { matchedBranches: 2, unmatchedTargets: [] });
  assert.equal(notification.stage, "ECHO");
  assert.equal(notification.branchCount, 2);
  assert.equal(notification.title, "FateDrop · Local Radar · Incoming stock");
  assert.match(notification.body, /Check Local Radar to see if a participating store is near you\.$/);
});

test("general operator intelligence remains Whisper without an explicit Echo request", () => {
  const parsed = parseOperatorIssue(operatorIssue({ body: { sourceType: "operator_manual", kind: null, confidence: 0.99 } }), NOW);
  assert.equal(parsed.entry.kind, "whisper");
  assert.equal(parsed.entry.confidence, 0.59);
});

test("operator intake rejects untrusted authors, pull requests and branchless broadcasts", () => {
  assert.throws(() => parseOperatorIssue(operatorIssue({ user: { login: "someone-else" } }), NOW), /author is not authorised/);
  assert.throws(() => parseOperatorIssue(operatorIssue({ pull_request: { url: "https://example.invalid" } }), NOW), /Pull requests are not operator alerts/);
  assert.throws(() => parseOperatorIssue(operatorIssue({ body: { targetBranches: [] } }), NOW), /At least one named target branch is required/);
});

test("broadcast is held if the advertised branch count cannot be proven", () => {
  const parsed = parseOperatorIssue(operatorIssue(), NOW);
  assert.equal(buildOperatorNotification(parsed, {
    matchedBranches: 1,
    unmatchedTargets: [{ target: "The Entertainer Watford", reason: "branch_not_found" }],
  }), null);
});

test("operator issue requires the canonical store and persists Expected intelligence before Web publication", async () => {
  await assert.rejects(() => processOperatorIssue({ issue: operatorIssue(), now: NOW }), /requires the canonical store/);

  const saved = [];
  let outbound = null;
  const store = {
    async listRetailerLocations() {
      return [
        { id: "loc-bromley", retailerId: "entertainer-uk", name: "The Entertainer Bromley Lower Mall", address: "Bromley", postcode: "BR1 1DN" },
        { id: "loc-watford", retailerId: "entertainer-uk", name: "The Entertainer Watford", address: "Watford", postcode: "WD17 2UB" },
      ];
    },
    async upsertLocalStockObservations(observations) {
      saved.push(...observations);
      return { saved: observations.length, duplicates: 0 };
    },
  };
  const fetchImpl = async (url, options) => {
    outbound = { url: String(url), options };
    return new Response(JSON.stringify({ accepted: true, queued: 1, sent: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  const originalSecret = process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET;
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://fatedrop.example";
  process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET = "test-secret";
  try {
    const result = await processOperatorIssue({ issue: operatorIssue(), store, fetchImpl, now: NOW });
    assert.equal(result.accepted, true);
    assert.equal(result.persisted.saved, 2);
    assert.equal(result.published, true);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].stockStatus, "expected");
    assert.equal(saved[0].sourceType, "official_retailer_page");
    assert.equal(saved[0].confidence, 0.68);
    assert.equal(saved[0].retailerId, "entertainer-uk");
    assert.equal(saved[0].locationId, "loc-bromley");
    assert.equal(saved[1].locationId, "loc-watford");
    assert.equal(outbound.url, "https://fatedrop.example/api/dashboard/local-radar-operator-alert");
    assert.equal(outbound.options.headers.Authorization, "Bearer test-secret");
    const payload = JSON.parse(outbound.options.body);
    assert.equal(payload.stage, "ECHO");
    assert.equal(payload.branchCount, 2);
    assert.equal(payload.operatorIssue, 301);
  } finally {
    if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET = originalSecret;
  }
});

test("production server owns lifecycle heartbeat and Local Radar operator intake", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/http/fatedrop-server.mjs", import.meta.url), "utf8"));
  assert.match(source, /startSignalLifecycleHeartbeat/);
  assert.match(source, /startOperatorLocalRadarWatcher/);
});

test("operator watcher reuses the production canonical store and never owns a pg pool", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/http/fatedrop-server.mjs", import.meta.url), "utf8"));
  assert.match(source, /startOperatorLocalRadarWatcher\(\{ store \}\)/);
  assert.doesNotMatch(source, /startOperatorLocalRadarWatcher\(\{[\s\S]*databaseUrl/);
});

test("read-only exact-branch inspection never invokes Local Radar persistence", async () => {
  let writes = 0;
  const store = {
    async listRetailerLocations() {
      return [
        { id: "loc-bromley", retailerId: "entertainer-uk", name: "The Entertainer Bromley Lower Mall", address: "Bromley", postcode: "BR1 1DN" },
      ];
    },
    async upsertLocalStockObservations() {
      writes += 1;
      throw new Error("read-only inspection must not write");
    },
  };
  const issue = operatorIssue({ body: { targetBranches: ["The Entertainer Bromley Lower Mall"] } });
  const parsed = parseOperatorIssue(issue, NOW);
  const { inspectCuratedIncomingIntelTargets } = await import("../src/encounters/curated-incoming-intel-reconcile.mjs");
  const result = await inspectCuratedIncomingIntelTargets({ store, entries: [parsed.entry], now: NOW });
  assert.equal(result.matchedBranches, 1);
  assert.equal(result.unmatchedTargets.length, 0);
  assert.equal(writes, 0);
});

test("testOnly requires the exact TEST ONLY issue title in both directions", () => {
  assert.throws(() => parseOperatorIssue(operatorIssue({ body: { testOnly: true } }), NOW), /must use the exact TEST ONLY title/);
  assert.throws(() => parseOperatorIssue(operatorIssue({ title: "[FATEDROP LOCAL RADAR] TEST ONLY" }), NOW), /must set testOnly=true/);
});

test("test-only operator issue reconciles canonical branches read-only and still publishes through the real bridge", async () => {
  let writes = 0;
  let outbound = null;
  const store = {
    async listRetailerLocations() {
      return [
        { id: "loc-bromley", retailerId: "entertainer-uk", name: "The Entertainer Bromley Lower Mall", address: "Bromley", postcode: "BR1 1DN" },
        { id: "loc-watford", retailerId: "entertainer-uk", name: "The Entertainer Watford", address: "Watford", postcode: "WD17 2UB" },
      ];
    },
    async upsertLocalStockObservations() {
      writes += 1;
      throw new Error("TEST ONLY must not persist Local Radar observations");
    },
  };
  const fetchImpl = async (url, options) => {
    outbound = { url: String(url), options };
    return new Response(JSON.stringify({ accepted: true, queued: 1, sent: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const issue = operatorIssue({ title: "[FATEDROP LOCAL RADAR] TEST ONLY", body: { testOnly: true } });

  const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  const originalSecret = process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET;
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://fatedrop.example";
  process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET = "test-secret";
  try {
    const result = await processOperatorIssue({ issue, store, fetchImpl, now: NOW });
    assert.equal(result.accepted, true);
    assert.equal(result.persisted.saved, 0);
    assert.equal(result.persisted.duplicates, 0);
    assert.equal(result.published, true);
    assert.equal(writes, 0);
    assert.equal(outbound.url, "https://fatedrop.example/api/dashboard/local-radar-operator-alert");
    assert.equal(outbound.options.headers.Authorization, "Bearer test-secret");
    const payload = JSON.parse(outbound.options.body);
    assert.equal(payload.testOnly, true);
    assert.equal(payload.stage, "ECHO");
    assert.equal(payload.branchCount, 2);
    assert.equal(payload.operatorIssue, 301);
  } finally {
    if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_SECRET = originalSecret;
  }
});
