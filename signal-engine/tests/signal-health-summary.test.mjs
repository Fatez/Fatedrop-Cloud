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
    ],
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

test("signal health loader prefers canonical network snapshot retailer freshness", async () => {
  const now = 1_800_000_000;
  const query = async (sql) => {
    if (sql.includes("latest_signal_at")) return { rows: [{ latest_signal_at: null, latest_discord_attempt_at: null, recent_signals: 0, recent_discord_attempts: 0 }] };
    return { rows: [] };
  };
  const store = {
    pool: async () => ({ query }),
    listNetworkSnapshots: async () => [{ retailers: [{ id: "snapshot-stale", healthy: false, stale: true, lastError: null }] }],
    listRetailers: async () => [{ id: "raw-healthy", healthy: true, lastError: null }],
  };

  const summary = await loadSignalHealthSummary(store, { days: 2, now });
  assert.deepEqual(summary.diagnostics.monitors.staleRetailerIds, ["snapshot-stale"]);
  assert.equal(summary.diagnostics.monitors.freshRetailers, 0);
});

test("signal health loader fails closed when a persistent ledger is unavailable", async () => {
  const result = await loadSignalHealthSummary({}, { days: 7, now: 1234 });
  assert.deepEqual(result, { available: false, reason: "persistent_store_unavailable", generatedAt: 1234 });
});
