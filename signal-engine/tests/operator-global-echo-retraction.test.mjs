import assert from "node:assert/strict";
import test from "node:test";

import {
  operatorEchoRetractionId,
  parseOperatorEchoRetraction,
  retractManualGlobalEcho,
  validateRetractableManualGlobalEcho,
} from "../src/encounters/operator-global-echo-retraction.mjs";

function manualEcho(id = "local-radar-operator:321") {
  return {
    id,
    kind: "operator_retailer_readiness",
    occurred_at: 1_788_350_000,
    evidence_json: {
      schemaVersion: 1,
      stage: "echo",
      signalKind: "operator_readiness",
      availabilityScope: "online_retailer_readiness",
      availabilityVerified: false,
      sourceType: "operator_manual",
      operatorIssue: 321,
      productTitle: "Time-sensitive collector intelligence",
    },
  };
}

function fakeStore({ owner = true, original = manualEcho() } = {}) {
  const events = new Map([[original.id, structuredClone(original)]]);
  const queries = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [], rowCount: 0 };
      if (text.includes("FROM fatedrop_admin_roles")) {
        return { rows: owner ? [{ user_id: params[0], role: "owner" }] : [], rowCount: owner ? 1 : 0 };
      }
      if (text.includes("FOR SHARE")) {
        const row = events.get(params[0]);
        return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("SELECT id,kind,occurred_at,evidence_json FROM fatedrop_signal_events")) {
        const row = events.get(params[0]);
        if (row && (!params[1] || row.kind === params[1])) return { rows: [structuredClone(row)], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO fatedrop_signal_events")) {
        if (!events.has(params[0])) {
          events.set(params[0], { id: params[0], kind: params[1], occurred_at: params[2], evidence_json: JSON.parse(params[3]) });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    release() {},
  };
  return {
    events,
    queries,
    store: { async pool() { return { async connect() { return client; } }; } },
  };
}

test("manual Global Echo retraction id is deterministic", () => {
  assert.equal(operatorEchoRetractionId("local-radar-operator:321"), "operator-echo-retraction:local-radar-operator:321");
});

test("automated or authoritative lifecycle records cannot be retracted", () => {
  assert.throws(() => validateRetractableManualGlobalEcho({
    kind: "operator_retailer_readiness",
    evidence_json: { schemaVersion: 1, stage: "echo", signalKind: "operator_readiness", availabilityScope: "online_retailer_readiness", availabilityVerified: false, sourceType: "official_retailer_page", operatorIssue: 321 },
  }), /manually created Global Echoes/i);
  assert.throws(() => validateRetractableManualGlobalEcho({ kind: "manifested", evidence_json: {} }), /Only manual operator Echoes/i);
});

test("normal tester is rejected by server-owned owner role", async () => {
  const fixture = fakeStore({ owner: false });
  await assert.rejects(
    retractManualGlobalEcho({ store: fixture.store, eventId: "local-radar-operator:321", reason: "Wrong message", retractedBy: "user-tester", now: 1_788_360_000_000 }),
    (error) => error?.code === "OWNER_REQUIRED",
  );
  assert.equal(fixture.events.size, 1);
});

test("authorised owner appends one immutable retraction audit event without lifecycle mutation", async () => {
  const fixture = fakeStore();
  const originalBefore = structuredClone(fixture.events.get("local-radar-operator:321"));
  const result = await retractManualGlobalEcho({
    store: fixture.store,
    eventId: "local-radar-operator:321",
    reason: "Headline linked to the wrong page",
    retractedBy: "internal-user-owner",
    now: 1_788_360_000_000,
  });
  assert.equal(result.retracted, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(fixture.events.get("local-radar-operator:321"), originalBefore, "original record/payload must remain immutable");
  const audit = fixture.events.get(operatorEchoRetractionId("local-radar-operator:321"));
  const retraction = parseOperatorEchoRetraction(audit, "local-radar-operator:321");
  assert.equal(retraction.status, "retracted");
  assert.equal(retraction.retractedBy, "internal-user-owner");
  assert.equal(retraction.reason, "Headline linked to the wrong page");
  assert.equal(audit.evidence_json.lifecycleEffect, "none");
  assert.equal(audit.evidence_json.canonicalStockTruthChanged, false);
  assert.equal([...fixture.events.values()].some((event) => event.kind === "manifested" || event.kind === "vanished"), false);
});

test("duplicate retraction is harmless and does not create a second audit event", async () => {
  const fixture = fakeStore();
  const first = await retractManualGlobalEcho({ store: fixture.store, eventId: "local-radar-operator:321", reason: "Wrong link", retractedBy: "internal-user-owner", now: 1_788_360_000_000 });
  const second = await retractManualGlobalEcho({ store: fixture.store, eventId: "local-radar-operator:321", reason: "Second wording should not duplicate audit", retractedBy: "internal-user-owner", now: 1_788_360_100_000 });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(fixture.events.size, 2);
  assert.equal(second.retraction.reason, "Wrong link");
});
