import test from "node:test";
import assert from "node:assert/strict";
import { recordSignalDeliveryAttempt } from "../src/telemetry/signal-delivery.mjs";

test("signal delivery telemetry is inert for non-persistent stores", async () => {
  const result = await recordSignalDeliveryAttempt({}, {
    signalId: "sig-test",
    channel: "discord",
    attemptedAt: 1_700_000_000,
    result: "sent",
  });
  assert.deepEqual(result, { recorded: false, reason: "store_not_persistent" });
});

test("signal delivery telemetry writes only delivery evidence", async () => {
  let query = null;
  const store = {
    pool: async () => ({
      query: async (sql, values) => {
        query = { sql, values };
        return { rows: [] };
      },
    }),
  };

  const result = await recordSignalDeliveryAttempt(store, {
    signalId: "sig-test",
    channel: "discord",
    attemptedAt: 1_700_000_000,
    result: "sent",
    providerMessageId: "discord-message-123",
    detail: null,
  });

  assert.equal(result.recorded, true);
  assert.match(query.sql, /INSERT INTO fatedrop_signal_delivery_attempts/);
  assert.equal(query.values[1], "sig-test");
  assert.equal(query.values[2], "discord");
  assert.equal(query.values[3], 1_700_000_000);
  assert.equal(query.values[4], "sent");
  assert.equal(query.values[5], "discord-message-123");
});
