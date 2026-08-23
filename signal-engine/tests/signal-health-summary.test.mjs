import assert from "node:assert/strict";
import test from "node:test";

import { buildSignalHealthSummary, loadSignalHealthSummary } from "../src/telemetry/signal-health-summary.mjs";

test("signal health summary keeps detections, sent alerts, policy suppression and issues separate by UTC day", () => {
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
      { state: "manifested", measured_at: aug22, result: "sent", detail: "", count: 3 },
      { state: "manifested", measured_at: aug23, result: "sent", detail: "channel_id:123", count: 7 },
    ],
  });

  assert.equal(summary.available, true);
  assert.equal(summary.lifecycle.manifested.total, 28);
  assert.equal(summary.lifecycle.manifested.today, 7);
  assert.equal(summary.lifecycle.vanished.total, 5);
  assert.equal(summary.delivery.manifested.sent, 28);
  assert.equal(summary.delivery.manifested.todaySent, 7);
  assert.equal(summary.delivery.manifested.policySkipped, 287);
  assert.equal(summary.delivery.manifested.issues, 1);
  assert.equal(summary.lifecycle.manifested.trend.length, 7);
  assert.equal(summary.delivery.manifested.trend.length, 7);
});

test("signal health loader fails closed when a persistent ledger is unavailable", async () => {
  const result = await loadSignalHealthSummary({}, { days: 7, now: 1234 });
  assert.deepEqual(result, { available: false, reason: "persistent_store_unavailable", generatedAt: 1234 });
});
