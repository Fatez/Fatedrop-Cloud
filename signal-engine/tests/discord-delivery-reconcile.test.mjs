import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reconcileSource = await readFile(new URL("../src/notifications/discord-reconcile.mjs", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("orphaned lifecycle Discord deliveries are reconciled durably", () => {
  assert.match(reconcileSource, /fatedrop_signal_delivery_attempts/);
  assert.match(reconcileSource, /NOT EXISTS/);
  assert.match(reconcileSource, /detected_at <= \$2/);
  assert.match(reconcileSource, /DEFAULT_GRACE_SECONDS = 90/);
  assert.match(reconcileSource, /DEFAULT_LOOKBACK_SECONDS = 24 \* 60 \* 60/);
  assert.match(reconcileSource, /DEFAULT_BATCH_LIMIT = 25/);
  assert.match(reconcileSource, /pg_try_advisory_lock/);
  assert.match(reconcileSource, /dispatchDiscordSignals/);
  assert.match(reconcileSource, /recordSignalDeliveryAttempt/);
});

test("delivery reconciliation runs independently of retailer scans", () => {
  assert.match(serverSource, /reconcileMissingDiscordDeliveries/);
  assert.match(serverSource, /DISCORD_DELIVERY_RECONCILE_INTERVAL_MS = 60 \* 1000/);
  assert.match(serverSource, /void reconcileDiscordDeliveries\(\)/);
  assert.match(serverSource, /setInterval\(reconcileDiscordDeliveries, DISCORD_DELIVERY_RECONCILE_INTERVAL_MS\)/);
});
