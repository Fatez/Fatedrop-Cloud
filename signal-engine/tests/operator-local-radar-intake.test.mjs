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
  assert.equal(parsed.entry.expiresAt, "2026-08-30T23:00:00.000Z");
  const notification = buildOperatorNotification(parsed, { matchedBranches: 2, unmatchedTargets: [] });
  assert.equal(notification.stage, "ECHO");
  assert.equal(notification.branchCount, 2);
  assert.equal(notification.title, "FateDrop · Local Radar · Incoming stock");
  assert.match(notification.body, /expected at 2 The Entertainer stores tomorrow, 30 August\./);
  assert.match(notification.body, /Check Local Radar to see if a participating store is near you\.$/);
});

test("operator expiry cannot kill a future physical-stock Echo before its expected date", () => {
  const parsed = parseOperatorIssue(operatorIssue({
    body: {
      expectedFrom: "2026-09-01T00:00:00+01:00",
      expectedTo: "2026-09-01T23:59:59+01:00",
      expectedLabel: "Expected 1 September",
      expiresAt: "2026-08-28T23:59:59+01:00",
    },
  }), NOW);
  assert.equal(parsed.entry.expiresAt, "2026-09-01T23:00:00.000Z");
});

test("general operator intelligence cannot self-promote to Echo", () => {
  const parsed = parseOperatorIssue(operatorIssue({ body: { sourceType: "operator_manual", kind: "echo", confidence: 0.99 } }), NOW);
  assert.equal(parsed.entry.kind, "whisper");
  assert.equal(parsed.entry.confidence, 0.59);
});

test("operator intake rejects untrusted authors and requires chain-grade provenance for branchless Echo", () => {
  assert.throws(() => parseOperatorIssue(operatorIssue({ user: { login: "someone-else" } }), NOW), /author is not authorised/);
  assert.throws(() => parseOperatorIssue(operatorIssue({ pull_request: { url: "https://example.invalid" } }), NOW), /Pull requests are not operator alerts/);
  assert.throws(
    () => parseOperatorIssue(operatorIssue({ body: { targetBranches: [], sourceType: "operator_manual", kind: "echo" } }), NOW),
    /retailer-chain Echo provenance/,
  );
  assert.throws(
    () => parseOperatorIssue(operatorIssue({ body: { targetBranches: [], sourceType: "official_retailer_page", kind: "echo" } }), NOW),
    /retailer-chain Echo provenance/,
  );

  const chainEcho = parseOperatorIssue(operatorIssue({ body: { targetBranches: [], sourceType: "retailer_staff_report", kind: "echo" } }), NOW);
  assert.equal(chainEcho.entry.kind, "echo");
  assert.deepEqual(chainEcho.entry.targetBranches, []);
});

test("unresolved canonical branch coverage does not suppress a strong advisory Echo", () => {
  const parsed = parseOperatorIssue(operatorIssue(), NOW);
  const notification = buildOperatorNotification(parsed, {
    matchedBranches: 1,
    unmatchedTargets: [{ target: "The Entertainer Watford", reason: "branch_not_found" }],
  });
  assert.equal(notification.stage, "ECHO");
  assert.equal(notification.branchCount, 1);
  assert.match(notification.body, /expected at participating The Entertainer stores tomorrow, 30 August\./);
  assert.match(notification.body, /Exact participating branches are still being resolved\./);
});

test("branchless chain-level Echo stays visible without fabricating branch stock", () => {
  const parsed = parseOperatorIssue(operatorIssue({ body: { targetBranches: [], sourceType: "retailer_staff_report", kind: "echo" } }), NOW);
  const notification = buildOperatorNotification(parsed, { matchedBranches: 0, unmatchedTargets: [] });
  assert.equal(notification.stage, "ECHO");
  assert.equal(notification.branchCount, 0);
  assert.match(notification.body, /expected at participating The Entertainer stores tomorrow, 30 August\./);
  assert.match(notification.body, /Exact participating branches are still being resolved\./);
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
  const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://fatedrop.co.uk/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  try {
    const result = await processOperatorIssue({ issue: operatorIssue(), store, fetchImpl, now: NOW });
    assert.equal(result.status, "published");
    assert.equal(result.matchedBranches, 2);
    assert.equal(result.retailerChainRecords, 0);
    assert.equal(saved.length, 2);
    for (const observation of saved) {
      assert.equal(observation.kind, "echo");
      assert.equal(observation.evidence.localIntel, true);
      assert.equal(observation.evidence.advisory, true);
      assert.equal(observation.evidence.availabilityVerified, false);
      assert.equal(observation.evidence.expiresAt, "2026-08-30T23:00:00.000Z");
    }
    assert.equal(outbound.url, "https://fatedrop.co.uk/api/dashboard/local-radar-operator-alert");
    assert.equal(outbound.options.headers.Authorization, "Bearer test-secret");
    const payload = JSON.parse(outbound.options.body);
    assert.equal(payload.eventId, "local-radar-operator:301");
    assert.equal(payload.stage, "ECHO");
    assert.equal(payload.branchCount, 2);
  } finally {
    if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
    else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
  }
});

test("branchless strong Echo publishes and persists only one retailer-chain advisory record", async () => {
  const saved = [];
  let outbound = null;
  const store = {
    async listRetailerLocations() {
      return [];
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
  const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://fatedrop.co.uk/api/dashboard/network-snapshot";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  try {
    const issue = operatorIssue({ body: { targetBranches: [], sourceType: "retailer_staff_report", kind: "echo" } });
    const result = await processOperatorIssue({ issue, store, fetchImpl, now: NOW });
    assert.equal(result.status, "published");
    assert.equal(result.matchedBranches, 0);
    assert.equal(result.retailerChainRecords, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].locationId, null);
    assert.equal(saved[0].kind, "echo");
    assert.equal(saved[0].evidence.scope, "retailer_chain");
    assert.equal(saved[0].evidence.localIntel, true);
    assert.equal(saved[0].evidence.advisory, true);
    assert.equal(saved[0].evidence.availabilityVerified, false);
    assert.equal(saved[0].evidence.branchVerified, false);
    const payload = JSON.parse(outbound.options.body);
    assert.equal(payload.stage, "ECHO");
    assert.equal(payload.branchCount, 0);
    assert.match(payload.body, /Exact participating branches are still being resolved\./);
  } finally {
    if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
    else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
  }
});
