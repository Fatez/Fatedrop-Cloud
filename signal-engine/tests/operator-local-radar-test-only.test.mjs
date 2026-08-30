import assert from "node:assert/strict";
import test from "node:test";

import { inspectCuratedIncomingIntelTargets } from "../src/encounters/curated-incoming-intel-reconcile.mjs";
import { parseOperatorIssue, processOperatorIssue } from "../src/encounters/operator-local-radar-intake.mjs";

const NOW = Date.parse("2026-08-30T08:00:00+01:00");
const LOCATIONS = [
  { id: "loc-watford", retailerId: "entertainer-uk", name: "The Entertainer Watford", address: "Watford", postcode: "WD17 2UB" },
];

function testIssue(overrides = {}) {
  const body = {
    schemaVersion: 1,
    testOnly: true,
    retailerId: "entertainer-uk",
    retailerName: "The Entertainer",
    rawProductTitle: "TEST ONLY · Local Radar operator transport",
    kind: "whisper",
    sourceType: "operator_manual",
    sourceLabel: "FateDrop TEST ONLY transport verification",
    expectedLabel: "TEST ONLY",
    expiresAt: "2026-08-31T23:59:59+01:00",
    confidence: 0.2,
    targetBranches: ["The Entertainer Watford"],
    ...overrides.body,
  };
  return {
    number: 999,
    state: "open",
    title: "[FATEDROP LOCAL RADAR] TEST ONLY",
    body: JSON.stringify(body),
    created_at: "2026-08-30T07:59:00+01:00",
    updated_at: "2026-08-30T07:59:00+01:00",
    user: { login: "Fatez" },
    ...overrides,
    body: JSON.stringify(body),
  };
}

test("read-only exact-branch inspection never invokes Local Radar persistence", async () => {
  let writes = 0;
  const store = {
    async listRetailerLocations() { return LOCATIONS; },
    async upsertLocalStockObservations() { writes += 1; throw new Error("test-only inspection must never write"); },
  };
  const result = await inspectCuratedIncomingIntelTargets({
    store,
    entries: [{
      id: "test-only",
      retailerId: "entertainer-uk",
      kind: "whisper",
      rawProductTitle: "TEST ONLY",
      sourceType: "operator_manual",
      sourceId: "test-only",
      sourceLabel: "TEST ONLY",
      observedAt: "2026-08-30T07:59:00+01:00",
      expectedLabel: "TEST ONLY",
      expiresAt: "2026-08-31T23:59:59+01:00",
      confidence: 0.1,
      targetBranches: ["The Entertainer Watford"],
    }],
    now: NOW,
  });
  assert.equal(result.matchedBranches, 1);
  assert.equal(result.unmatchedTargets.length, 0);
  assert.equal(result.persisted, false);
  assert.equal(writes, 0);
  assert.match(result.truthRule, /No Local Radar observation, stock state or history is written/);
});

test("testOnly requires the exact TEST ONLY issue title in both directions", () => {
  assert.throws(
    () => parseOperatorIssue(testIssue({ title: "[FATEDROP LOCAL RADAR] Incoming stock" }), NOW),
    /exact TEST ONLY title/,
  );
  assert.throws(
    () => parseOperatorIssue(testIssue({ body: { testOnly: false } }), NOW),
    /must set testOnly=true/,
  );
});

test("test-only operator issue reconciles canonical branches read-only and still publishes through the real bridge", async () => {
  let writes = 0;
  let outbound = null;
  const store = {
    async listRetailerLocations() { return LOCATIONS; },
    async upsertLocalStockObservations() { writes += 1; throw new Error("TEST ONLY must never persist"); },
  };
  const fetchImpl = async (url, options) => {
    outbound = { url: String(url), options };
    return new Response(JSON.stringify({ accepted: true, queued: 1, sent: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://fatedrop.co.uk";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  try {
    const result = await processOperatorIssue({ issue: testIssue(), store, fetchImpl, now: NOW });
    assert.equal(result.status, "published");
    assert.equal(result.testOnly, true);
    assert.equal(result.matchedBranches, 1);
    assert.equal(writes, 0);
    assert.match(result.truthRule, /No Local Radar observation, stock state or history is written/);

    assert.equal(outbound.url, "https://fatedrop.co.uk/api/dashboard/local-radar-operator-alert");
    assert.equal(outbound.options.headers.Authorization, "Bearer test-secret");
    const payload = JSON.parse(outbound.options.body);
    assert.equal(payload.eventId, "local-radar-operator-test:999");
    assert.equal(payload.testOnly, true);
    assert.equal(payload.title, "FateDrop · Local Radar · TEST ONLY");
    assert.match(payload.body, /^TEST ONLY ·/);
    assert.match(payload.body, /No stock or Local Radar history has been created\.$/);
  } finally {
    if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
    else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
  }
});
