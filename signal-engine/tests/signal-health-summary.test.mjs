import assert from "node:assert/strict";
import test from "node:test";

import { buildSignalHealthSummary, loadSignalHealthSummary } from "../src/telemetry/signal-health-summary.mjs";

test("signal health summary separates detections, delivery policy, duplicate suppression, latency and issues", () => {
  const now = Date.UTC(2026, 7, 23, 21, 0, 0) / 1000;
  const aug21 = Date.UTC(2026, 7, 21) / 1000;
  const aug22 = Date.UTC(2026, 7, 22) / 1000;
  const aug23 = Date.UTC(2026, 7, 23) / 1000;
  const summary = buildSignalHealthSummary({
    now,
    days: 7,
    detectionRows: [
      { state: "manifested", measured_at: aug21, count: 18 },
      { state: "manifested", measured_at: aug22, count: 3 },
      { state: "manifested", measured_at: aug23, count: 7 },
      { state: "vanished", measured_at: aug23, count: 5 },
    ],
    deliveryRows: [
      { state: "manifested", measured_at: aug21, result: "sent", detail: "", count: 18 },
      { state: "manifested", measured_at: aug21, result: "skipped", detail: "disabled", count: 287 },
      { state: "manifested", measured_at: aug21, result: "skipped", detail: "missing_bot_token", count: 1 },
      { state: "manifested", measured_at: aug22, result: "skipped", detail: "duplicate_batch_signal", count: 2 },
      { state: "manifested", measured_at: aug22, result: "sent", detail: "", count: 3 },
      { state: "manifested", measured_at: aug23, result: "sent", detail: "channel_id:123", count: 7 },
    ],
    latencyRows: [
      { state: "manifested", sample_size: 28, median_seconds: 4, p95_seconds: 11 },
      { state: "__all__", sample_size: 28, median_seconds: 4, p95_seconds: 11 },
    ],
    monitorRows: [
      { id: "fresh", healthy: true, stale: false, lastError: null },
      { id: "stale", healthy: false, stale: true, lastError: null },
      { id: "blocked", healthy: false, stale: false, lastError: "Retailer blocked catalogue request (403)" },
      { id: "onboarding", healthy: false, stale: false, lastSuccessAt: null, lastError: "zero products" },
      { id: "regressed", healthy: false, stale: false, lastSuccessAt: now - 100, failureCode: "partial_catalogue_discovery", lastError: "parser changed" },
      { id: "candidate", healthy: false, stale: false, registryState: "candidate", lastError: "old failure" },
    ],
    discoveryRows: [{
      discovery_available: true,
      pending: 2,
      retry: 1,
      processed: 9,
      failed: 1,
      latest_observed_at: now - 60,
      latest_processed_at: now - 90,
      oldest_active_at: now - 600,
    }],
    identityFacetRows: [{
      record_kind: "signal",
      signal_id: "sig-unresolved",
      offer_id: "offer-unresolved",
      canonical_product_id: "prd-unresolved",
      canonical_key: "booster_box:unresolved",
      retailer_name: "Retailer A",
      tcg: "pokemon",
      title: "Pokémon Unresolved Booster Box",
      observed_at: now - 30,
      evidence: [],
    }],
  });

  assert.equal(summary.available, true);
  assert.equal(summary.lifecycle.manifested.total, 28);
  assert.equal(summary.lifecycle.manifested.today, 7);
  assert.equal(summary.lifecycle.vanished.total, 5);
  assert.equal(summary.delivery.manifested.sent, 28);
  assert.equal(summary.delivery.manifested.todaySent, 7);
  assert.equal(summary.delivery.manifested.policySkipped, 287);
  assert.equal(summary.delivery.manifested.duplicateSuppressed, 2);
  assert.equal(summary.delivery.manifested.issues, 1);
  assert.equal(summary.delivery.manifested.medianLatencySeconds, 4);
  assert.equal(summary.delivery.manifested.p95LatencySeconds, 11);
  assert.deepEqual(summary.diagnostics.absentLifecycleStages, ["whisper", "echo"]);
  assert.equal(summary.diagnostics.duplicateSignalsSuppressed, 2);
  assert.deepEqual(summary.diagnostics.discordLatency, { sampleSize: 28, medianSeconds: 4, p95Seconds: 11 });
  assert.deepEqual(summary.diagnostics.monitors.staleRetailerIds, ["stale"]);
  assert.deepEqual(summary.diagnostics.monitors.blockedRetailerIds, ["blocked"]);
  assert.deepEqual(summary.diagnostics.monitors.onboardingRetailerIds, ["onboarding"]);
  assert.deepEqual(summary.diagnostics.monitors.regressedRetailerIds, ["regressed"]);
  assert.deepEqual(summary.diagnostics.monitors.excludedRetailerIds, ["candidate"]);
  assert.equal(summary.diagnostics.monitors.totalRetailers, 5);
  assert.equal(summary.diagnostics.monitors.unhealthyRetailers, 1);
  assert.equal(summary.diagnostics.monitors.failureClassCounts.access_blocked, 1);
  assert.equal(summary.diagnostics.monitors.failureClassCounts.partial_catalogue, 1);
  assert.equal(summary.diagnostics.monitors.failureClassCounts.none, 1);
  assert.equal(summary.diagnostics.monitors.failureClassCounts.stale_observation, 1);
  assert.deepEqual(summary.diagnostics.monitors.recoveryQueue.find((item) => item.id === "regressed"), {
    id: "regressed",
    failureCode: "partial_catalogue_discovery",
    recoveryAction: "repair_catalogue_discovery",
    backoffSeconds: 1800,
    quarantineState: "retry_managed",
  });
  assert.deepEqual(summary.diagnostics.discovery, {
    available: true,
    pending: 2,
    retry: 1,
    processed: 9,
    failed: 1,
    latestObservedAt: now - 60,
    latestProcessedAt: now - 90,
    oldestActiveAt: now - 600,
  });
  assert.equal(summary.diagnostics.identityFacets.available, true);
  assert.equal(summary.diagnostics.identityFacets.totals.unresolvedCanonicalIdentity, 1);
  assert.equal(summary.diagnostics.identityFacets.candidates[0].canonicalProductId, "prd-unresolved");
  assert.equal(summary.lifecycle.manifested.trend.length, 7);
  assert.equal(summary.delivery.manifested.trend.length, 7);
});

test("reliability diagnostics expose orphaned signals and telemetry stoppage explicitly", () => {
  const now = 1_800_000_000;
  const summary = buildSignalHealthSummary({
    now,
    days: 2,
    orphanRows: [
      { id: "sig_orphan", state: "whisper", retailer_id: "retailer-a", retailer_name: "Retailer A", title: "New ETB", detected_at: now - 300 },
    ],
    freshnessRows: [{ latest_signal_at: now - 300, latest_discord_attempt_at: null, recent_signals: 1, recent_discord_attempts: 0 }],
    monitorRows: [{ id: "pokemon-center-uk", healthy: false, stale: true, lastError: null }],
  });

  assert.equal(summary.diagnostics.reliability.orphanGraceSeconds, 120);
  assert.equal(summary.diagnostics.reliability.orphanedDiscordSignals, 1);
  assert.deepEqual(summary.diagnostics.reliability.orphanedSignalIds, ["sig_orphan"]);
  assert.equal(summary.diagnostics.reliability.telemetryStoppedWhileSignalsContinue, true);
  assert.deepEqual(summary.diagnostics.monitors.staleRetailerIds, ["pokemon-center-uk"]);
});

test("discovery diagnostics keep telemetry unavailable distinct from an empty backlog", () => {
  const summary = buildSignalHealthSummary({ days: 2, now: 1_800_000_000 });
  assert.deepEqual(summary.diagnostics.discovery, {
    available: false,
    pending: 0,
    retry: 0,
    processed: 0,
    failed: 0,
    latestObservedAt: null,
    latestProcessedAt: null,
    oldestActiveAt: null,
  });
});

test("signal health loader uses the live retailer ledger instead of a historical network snapshot", async () => {
  const now = 1_800_000_000;
  const query = async (sql) => {
    if (sql.includes("latest_signal_at")) return { rows: [{ latest_signal_at: null, latest_discord_attempt_at: null, recent_signals: 0, recent_discord_attempts: 0 }] };
    if (sql.includes("fatedrop_retailer_discovery_evidence")) return { rows: [{ discovery_available: true, pending: 0, retry: 0, processed: 3, failed: 0, latest_observed_at: now - 10, latest_processed_at: now - 5, oldest_active_at: null }] };
    return { rows: [] };
  };
  const store = {
    pool: async () => ({ query }),
    listNetworkSnapshots: async () => [{ retailers: [{ id: "snapshot-stale", healthy: false, stale: true, lastError: null }] }],
    listRetailers: async () => [{ id: "raw-healthy", healthy: true, lastError: null }],
  };

  const summary = await loadSignalHealthSummary(store, { days: 2, now });
  assert.deepEqual(summary.diagnostics.monitors.staleRetailerIds, []);
  assert.equal(summary.diagnostics.monitors.freshRetailers, 1);
  assert.equal(summary.diagnostics.monitors.freshRetailerIds[0], "raw-healthy");
  assert.equal(summary.diagnostics.discovery.available, true);
  assert.equal(summary.diagnostics.discovery.processed, 3);
  assert.equal(summary.diagnostics.identityFacets.available, false);
});

test("identity audit reads are opt-in for authenticated operator health only", async () => {
  const now = 1_800_000_000;
  let identityQuerySeen = false;
  const query = async (sql) => {
    if (sql.includes("latest_signal_at")) return { rows: [{ latest_signal_at: null, latest_discord_attempt_at: null, recent_signals: 0, recent_discord_attempts: 0 }] };
    if (sql.includes("fatedrop_retailer_discovery_evidence")) return { rows: [{ discovery_available: true }] };
    if (sql.includes("WITH recent_signals AS")) {
      identityQuerySeen = true;
      assert.match(sql, /LIMIT 5000/);
      return { rows: [{
        record_kind: "signal",
        signal_id: "sig-audit",
        offer_id: "offer-audit",
        canonical_product_id: "prd-audit",
        canonical_key: "booster_box:audit",
        retailer_name: "Retailer A",
        tcg: "pokemon",
        title: "Pokémon Unresolved Booster Box",
        observed_at: now - 20,
        evidence: [],
      }] };
    }
    return { rows: [] };
  };
  const store = {
    pool: async () => ({ query }),
    listRetailers: async () => [],
  };

  const summary = await loadSignalHealthSummary(store, { days: 2, now, includeIdentityFacets: true });
  assert.equal(identityQuerySeen, true);
  assert.equal(summary.diagnostics.identityFacets.available, true);
  assert.equal(summary.diagnostics.identityFacets.totals.unresolvedCanonicalIdentity, 1);
});

test("signal health loader fails closed when a persistent ledger is unavailable", async () => {
  const result = await loadSignalHealthSummary({}, { days: 7, now: 1234 });
  assert.deepEqual(result, { available: false, reason: "persistent_store_unavailable", generatedAt: 1234 });
});
