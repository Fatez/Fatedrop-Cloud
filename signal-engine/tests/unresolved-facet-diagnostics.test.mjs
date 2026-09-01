import assert from "node:assert/strict";
import test from "node:test";

import { buildSignalHealthSummary, loadSignalHealthSummary } from "../src/telemetry/signal-health-summary.mjs";
import { buildUnresolvedFacetDiagnostics } from "../src/telemetry/unresolved-facet-diagnostics.mjs";

const rows = [
  { id: "a1", retailer_id: "retailer-a", retailer_name: "Retailer A", title: "Pokemon TCG: Mega Lucario ex League Battle Deck", detected_at: 100, facet_audit_total: 20 },
  { id: "a2", retailer_id: "retailer-b", retailer_name: "Retailer B", title: "Pokemon TCG Mega Lucario ex League Battle Deck", detected_at: 200, facet_audit_total: 20 },
  { id: "a3", retailer_id: "retailer-a", retailer_name: "Retailer A", title: "Pokemon TCG: First Partner Illustration Collection - Series 2", detected_at: 300, facet_audit_total: 20 },
  { id: "a4", retailer_id: "retailer-c", retailer_name: "Retailer C", title: "Pokemon Celebrations Elite Trainer Box (25th Anniversary)", detected_at: 400, facet_audit_total: 20 },
  { id: "a5", retailer_id: "retailer-c", retailer_name: "Retailer C", title: "Pokemon TCG Time Gazer S10D Korean Booster Box", detected_at: 500, facet_audit_total: 20 },
  { id: "a6", retailer_id: "retailer-b", retailer_name: "Retailer B", title: "Pokemon Pitch Black Japanese Build & Battle Box", detected_at: 600, facet_audit_total: 20 },
  { id: "a7", retailer_id: "retailer-d", retailer_name: "Retailer D", title: "Pokemon Premium Booster Box", detected_at: 700, facet_audit_total: 20 },
];

test("unresolved facet diagnostics classify without promoting Unknown truth", () => {
  const diagnostics = buildUnresolvedFacetDiagnostics(rows);
  assert.equal(diagnostics.available, true);
  assert.equal(diagnostics.sampleSize, 7);
  assert.equal(diagnostics.sampleTruncated, true);
  assert.equal(diagnostics.totalSignalsInWindow, 20);
  assert.deepEqual(diagnostics.counts, {
    totalUnresolvedLanguage: 6,
    totalUnresolvedSet: 4,
    bothUnresolved: 4,
    languageKnownSetUnknown: 0,
    setKnownLanguageUnknown: 1,
    conflictsQuarantined: 1,
    fullyResolved: 1,
  });

  const lucario = diagnostics.topUnresolved.find((entry) => entry.representativeTitle.includes("Mega Lucario"));
  assert.ok(lucario);
  assert.equal(lucario.resolution, "both_unresolved");
  assert.equal(lucario.count, 2);
  assert.equal(lucario.firstSeenAt, 100);
  assert.equal(lucario.lastSeenAt, 200);
  assert.equal(lucario.retailers.length, 2);
  assert.equal(lucario.setKey, null);
  assert.equal(lucario.languageGroup, "unknown");

  const celebrations = diagnostics.topUnresolved.find((entry) => entry.setKey === "celebrations");
  assert.ok(celebrations);
  assert.equal(celebrations.resolution, "set_known_language_unknown");
  assert.equal(celebrations.languageGroup, "unknown");

  const conflict = diagnostics.topUnresolved.find((entry) => entry.resolution === "conflict_quarantined");
  assert.ok(conflict);
  assert.equal(conflict.setKey, "pitch-black");
  assert.match(conflict.languageSource, /^language_conflict:/);

  assert.equal(diagnostics.topUnresolved.some((entry) => entry.representativeTitle.includes("Time Gazer")), false);
});

test("retailer distribution counts unresolved signals without creating lifecycle diagnostics", () => {
  const diagnostics = buildUnresolvedFacetDiagnostics(rows);
  const retailerA = diagnostics.retailerDistribution.find((entry) => entry.retailerId === "retailer-a");
  assert.deepEqual(retailerA, {
    retailerId: "retailer-a",
    retailerName: "Retailer A",
    unresolvedSignals: 2,
    unresolvedLanguage: 2,
    unresolvedSet: 2,
    bothUnresolved: 2,
    conflictsQuarantined: 0,
  });
});

test("signal health summary hosts unresolved facet diagnostics beside existing diagnostics", () => {
  const summary = buildSignalHealthSummary({
    now: 1_800_000_000,
    days: 2,
    facetRows: rows,
  });
  assert.equal(summary.available, true);
  assert.equal(summary.diagnostics.unresolvedFacets.available, true);
  assert.equal(summary.diagnostics.unresolvedFacets.counts.bothUnresolved, 4);
  assert.deepEqual(summary.diagnostics.absentLifecycleStages, ["whisper", "echo", "manifested", "vanished"]);
});

test("signal health loader derives facet audit from canonical public lifecycle signals and fails the audit closed if that optional query fails", async () => {
  const now = 1_800_000_000;
  let facetAuditQueries = 0;
  const query = async (sql) => {
    if (sql.includes("facet_audit_total")) {
      facetAuditQueries += 1;
      return { rows: [rows[0]] };
    }
    if (sql.includes("latest_signal_at")) {
      return { rows: [{ latest_signal_at: null, latest_discord_attempt_at: null, recent_signals: 0, recent_discord_attempts: 0 }] };
    }
    if (sql.includes("fatedrop_retailer_discovery_evidence")) {
      return { rows: [{ discovery_available: false }] };
    }
    return { rows: [] };
  };
  const store = {
    pool: async () => ({ query }),
    listRetailers: async () => [],
  };
  const summary = await loadSignalHealthSummary(store, { days: 2, now });
  assert.equal(facetAuditQueries, 1);
  assert.equal(summary.diagnostics.unresolvedFacets.available, true);
  assert.equal(summary.diagnostics.unresolvedFacets.counts.bothUnresolved, 1);

  const failingStore = {
    pool: async () => ({
      query: async (sql) => {
        if (sql.includes("facet_audit_total")) throw new Error("diagnostic query failed");
        if (sql.includes("latest_signal_at")) return { rows: [{}] };
        if (sql.includes("fatedrop_retailer_discovery_evidence")) return { rows: [{ discovery_available: false }] };
        return { rows: [] };
      },
    }),
    listRetailers: async () => [],
  };
  const failedAuditSummary = await loadSignalHealthSummary(failingStore, { days: 2, now });
  assert.equal(failedAuditSummary.available, true);
  assert.deepEqual(failedAuditSummary.diagnostics.unresolvedFacets, {
    available: false,
    reason: "facet_audit_unavailable",
    sampleSize: 0,
    sampleTruncated: false,
    totalSignalsInWindow: 0,
    counts: {
      totalUnresolvedLanguage: 0,
      totalUnresolvedSet: 0,
      bothUnresolved: 0,
      languageKnownSetUnknown: 0,
      setKnownLanguageUnknown: 0,
      conflictsQuarantined: 0,
      fullyResolved: 0,
    },
    topUnresolved: [],
    retailerDistribution: [],
  });
});
