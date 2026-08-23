import test from "node:test";
import assert from "node:assert/strict";
import { buildSignalDeliveryReport, flattenSignalDeliveryMetrics } from "../src/telemetry/signal-delivery-report.mjs";

test("delivery report is unavailable for non-persistent stores", async () => {
  const result = await buildSignalDeliveryReport({}, { since: 100, until: 200 });
  assert.equal(result.available, false);
  assert.equal(result.reason, "store_not_persistent");
  assert.deepEqual(flattenSignalDeliveryMetrics(result), {});
});

test("delivery report reconciles detected signals against final Discord delivery status", async () => {
  let query = null;
  const store = {
    pool: async () => ({
      query: async (sql, values) => {
        query = { sql, values };
        return { rows: [
          { state: "manifested", detected: 10, attempted: 8, sent: 5, skipped: 2, failed: 1, unaccounted: 2 },
          { state: "vanished", detected: 4, attempted: 4, sent: 3, skipped: 1, failed: 0, unaccounted: 0 },
        ] };
      },
    }),
  };

  const result = await buildSignalDeliveryReport(store, { since: 1_700_000_000, until: 1_700_086_400 });
  assert.equal(result.available, true);
  assert.match(query.sql, /bool_or\(attempt\.result = 'sent'\)/);
  assert.match(query.sql, /result IS NULL/);
  assert.deepEqual(query.values[2], ["whisper", "echo", "manifested", "vanished"]);
  assert.deepEqual(result.byState.manifested, {
    detected: 10, attempted: 8, sent: 5, skipped: 2, failed: 1, unaccounted: 2, deliveryRatePercent: 50,
  });
  assert.equal(result.byState.echo.detected, 0);
  assert.equal(result.totals.detected, 14);
  assert.equal(result.totals.sent, 8);
  assert.equal(result.totals.unaccounted, 2);
  assert.equal(result.totals.deliveryRatePercent, 57.1);
});

test("flattened metrics keep detected lifecycle counts separate from delivery outcomes", () => {
  const metrics = flattenSignalDeliveryMetrics({
    available: true,
    byState: {
      whisper: { detected: 20, attempted: 20, sent: 4, skipped: 16, failed: 0, unaccounted: 0 },
      echo: { detected: 1, attempted: 0, sent: 0, skipped: 0, failed: 0, unaccounted: 1 },
      manifested: { detected: 10, attempted: 8, sent: 5, skipped: 2, failed: 1, unaccounted: 2 },
      vanished: { detected: 4, attempted: 4, sent: 3, skipped: 1, failed: 0, unaccounted: 0 },
    },
  });

  assert.equal(metrics.manifestedDelivered, 5);
  assert.equal(metrics.manifestedUnaccounted, 2);
  assert.equal(metrics.discordDetected, 35);
  assert.equal(metrics.discordAttempted, 32);
  assert.equal(metrics.discordDelivered, 12);
  assert.equal(metrics.discordSkipped, 19);
  assert.equal(metrics.discordFailed, 1);
  assert.equal(metrics.discordUnaccounted, 3);
});
