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
    explicitTcgRelevance: true,
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
  assert.equal(parsed.entry.explicitTcgRelevance, true);
  const notification = buildOperatorNotification(parsed, { matchedBranches: 2, unmatchedTargets: [] });
  assert.equal(notification.stage, "ECHO");
  assert.equal(notification.branchCount, 2);
  assert.equal(notification.title, "FateDrop · Big Fate Signal · Echo");
  assert.equal(notification.presentationType, "big_fate_signal");
  assert.equal(notification.physicalEvidenceState, "expected");
  assert.equal(notification.deliveryPolicy, "radius_targeted_only");
  assert.equal(notification.radiusTargeted, false);
  assert.match(notification.body, /Physical availability is not confirmed\.$/);
});

test("general operator intelligence remains Whisper without an explicit Echo request", () => {
  const parsed = parseOperatorIssue(operatorIssue({ body: { sourceType: "operator_manual", kind: null, confidence: 0.99 } }), NOW);
  assert.equal(parsed.entry.kind, "whisper");
  assert.equal(parsed.entry.confidence, 0.59);
});

test("authorised operator can explicitly publish manual Local Radar Echo evidence", () => {
  const parsed = parseOperatorIssue(operatorIssue({ body: { sourceType: "operator_manual", kind: "echo", confidence: 0.99 } }), NOW);
  assert.equal(parsed.entry.kind, "echo");
  assert.equal(parsed.entry.physicalEvidenceState, "reported");
  assert.equal(parsed.entry.confidence, 0.8);
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

test("operator issue requires the canonical store and persists physical Echo while national delivery is held", async () => {
  await assert.rejects(() => processOperatorIssue({ issue: operatorIssue(), now: NOW }), /requires the canonical store/);

  const saved = [];
  let outbound = null;
  const store = {
    async listRetailerLocations() {
      return [
        { id: "loc-bromley", retailerId: "entertainer-uk", name: "The Entertainer Bromley Lower Mall", address: "Bromley", postcode: "BR1 1DN", storeFormat: "toy_store" },
        { id: "loc-watford", retailerId: "entertainer-uk", name: "The Entertainer Watford", address: "Watford", postcode: "WD17 2UB", storeFormat: "toy_store" },
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
    assert.equal(result.status, "ingested");
    assert.equal(result.matchedBranches, 2);
    assert.equal(saved.length, 2);
    for (const observation of saved) {
      assert.equal(observation.kind, "echo");
      assert.equal(observation.evidence.localIntel, true);
      assert.equal(observation.evidence.advisory, true);
      assert.equal(observation.evidence.availabilityVerified, false);
      assert.equal(observation.evidence.physicalEvidenceState, "expected");
    }
    assert.equal(outbound, null);
    assert.deepEqual(result.push, { published: false, reason: "radius_targeting_required" });
  } finally {
    if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
    else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
  }
});

test("authorised retailer-wide readiness movement publishes Echo without writing physical stock", async () => {
  let writes = 0;
  let outbound = null;
  const events = [];
  const store = {
    async upsertLocalStockObservations() { writes += 1; },
    async appendSignalEvent(event) { events.push(event); },
  };
  const fetchImpl = async (url, options) => {
    outbound = { url: String(url), options };
    return new Response(JSON.stringify({ accepted: true, queued: 1, sent: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const issue = operatorIssue({
    title: "[FATEDROP ECHO] Pokémon Centre readiness movement",
    body: {
      availabilityScope: "online_retailer_readiness",
      sourceType: "operator_manual",
      sourceUrl: "https://www.pokemoncenter.com/en-gb",
      targetBranches: [],
      expectedLabel: "Traffic and access movement observed",
    },
  });
  const originalUrl = process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
  const originalSecret = process.env.FATEDROP_METRICS_INGEST_SECRET;
  process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = "https://fatedrop.co.uk";
  process.env.FATEDROP_METRICS_INGEST_SECRET = "test-secret";
  try {
    const result = await processOperatorIssue({ issue, store, fetchImpl, now: NOW });
    assert.equal(result.status, "published");
    assert.equal(writes, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "operator_retailer_readiness");
    assert.equal(events[0].evidence.stage, "echo");
    assert.equal(events[0].evidence.availabilityVerified, false);
    assert.equal(events[0].evidence.tcgCode, "pokemon");
    const payload = JSON.parse(outbound.options.body);
    assert.equal(payload.stage, "ECHO");
    assert.equal(payload.route, "alerts");
    assert.equal(payload.availabilityScope, "online_retailer_readiness");
    assert.equal(payload.availabilityVerified, false);
    assert.equal(payload.tcgCode, "pokemon");
    assert.equal(payload.title, "Echo · Pokémon TCG: TEST Local Radar Incoming Stock");
    assert.equal(payload.body, "The Entertainer · Traffic and access movement observed\nPossible drop approaching · Stock not confirmed");
  } finally {
    if (originalUrl === undefined) delete process.env.FATEDROP_WEBSITE_SNAPSHOT_URL;
    else process.env.FATEDROP_WEBSITE_SNAPSHOT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.FATEDROP_METRICS_INGEST_SECRET;
    else process.env.FATEDROP_METRICS_INGEST_SECRET = originalSecret;
  }
});

test("operator readiness persists before delivery and inactive TCGs stay fail closed", async () => {
  const issue = operatorIssue({
    title: "[FATEDROP ECHO] One Piece readiness movement",
    body: {
      tcgCode: "one-piece",
      availabilityScope: "online_retailer_readiness",
      sourceType: "operator_manual",
      sourceUrl: "https://example.com/one-piece",
      targetBranches: [],
      expectedLabel: "Credible movement observed",
    },
  });
  assert.throws(() => parseOperatorIssue(issue, NOW), /Public lifecycle alerts are disabled for TCG: one-piece/);
});
