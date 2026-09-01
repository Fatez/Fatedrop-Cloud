import test from "node:test";
import assert from "node:assert/strict";

import { classifySignalStarvation } from "../src/telemetry/signal-starvation-watch.mjs";

function summary({
  generatedAt = "2026-09-01T12:00:00.000Z",
  latestSignalAt = Date.parse("2026-09-01T05:00:00.000Z") / 1000,
  recentSignals = 2,
  activeRetailers = 31,
  freshRetailers = 18,
  blockedRetailers = 7,
  degradedRetailers = 9,
} = {}) {
  return {
    available: true,
    generatedAt,
    diagnostics: {
      reliability: { latestSignalAt, recentSignals },
      monitors: {
        activeRetailers,
        freshRetailers,
        blockedRetailers,
        degradedRetailers,
      },
    },
  };
}

test("unavailable summaries never make a starvation claim", () => {
  assert.deepEqual(classifySignalStarvation({ available: false }), {
    status: "unknown",
    shouldAlert: false,
    reason: "signal_summary_unavailable",
  });
});

test("six-hour silence with meaningful fresh monitor coverage raises a warning", () => {
  const result = classifySignalStarvation(summary());
  assert.equal(result.status, "warning");
  assert.equal(result.shouldAlert, true);
  assert.equal(result.reason, "signal_starvation_despite_fresh_monitor_coverage");
  assert.equal(result.silenceSeconds, 7 * 60 * 60);
  assert.equal(result.activeRetailers, 31);
  assert.equal(result.freshRetailers, 18);
});

test("twelve-hour silence becomes critical without changing lifecycle truth", () => {
  const result = classifySignalStarvation(summary({
    latestSignalAt: Date.parse("2026-08-31T23:00:00.000Z") / 1000,
  }));
  assert.equal(result.status, "critical");
  assert.equal(result.shouldAlert, true);
  assert.equal(result.reason, "signal_starvation_despite_fresh_monitor_coverage");
  assert.equal(result.silenceSeconds, 13 * 60 * 60);
});

test("monitor degradation can support a starvation alert even when fresh coverage is weak", () => {
  const result = classifySignalStarvation(summary({
    freshRetailers: 2,
    blockedRetailers: 10,
    degradedRetailers: 20,
  }));
  assert.equal(result.status, "warning");
  assert.equal(result.shouldAlert, true);
  assert.equal(result.reason, "signal_starvation_with_monitor_degradation");
});

test("quiet periods do not alert when monitor evidence is too weak to support a starvation claim", () => {
  const result = classifySignalStarvation(summary({
    activeRetailers: 4,
    freshRetailers: 1,
    blockedRetailers: 0,
    degradedRetailers: 1,
  }));
  assert.equal(result.status, "healthy");
  assert.equal(result.shouldAlert, false);
  assert.equal(result.reason, "insufficient_monitor_coverage_for_starvation_claim");
});

test("no signal inside the 24-hour reliability window is treated as at least 24 hours of silence", () => {
  const result = classifySignalStarvation(summary({ latestSignalAt: null, recentSignals: 0 }));
  assert.equal(result.status, "critical");
  assert.equal(result.shouldAlert, true);
  assert.equal(result.silenceSeconds, 24 * 60 * 60);
});

test("recent signal activity remains healthy", () => {
  const result = classifySignalStarvation(summary({
    latestSignalAt: Date.parse("2026-09-01T10:30:00.000Z") / 1000,
  }));
  assert.equal(result.status, "healthy");
  assert.equal(result.shouldAlert, false);
  assert.equal(result.reason, "signal_activity_within_slo");
});
