import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { discordRecoveryDecision } from "../src/notifications/discord-reconcile.mjs";

const reconcileSource = await readFile(new URL("../src/notifications/discord-reconcile.mjs", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

const NOW = 2_000_000;
const signal = (state, ageSeconds) => ({ id: `sig_${state}`, state, detectedAt: NOW - ageSeconds });

test("orphaned lifecycle Discord deliveries are reconciled durably and freshness-aware", () => {
  assert.match(reconcileSource, /fatedrop_signal_delivery_attempts/);
  assert.match(reconcileSource, /result='sent'/);
  assert.match(reconcileSource, /DEFAULT_GRACE_SECONDS = 90/);
  assert.match(reconcileSource, /DEFAULT_RETRY_DELAY_SECONDS = 5 \* 60/);
  assert.match(reconcileSource, /manifested: 5 \* 60/);
  assert.match(reconcileSource, /echo: 5 \* 60/);
  assert.match(reconcileSource, /DEFAULT_BATCH_LIMIT = 25/);
  assert.match(reconcileSource, /pg_try_advisory_lock/);
  assert.match(reconcileSource, /dispatchDiscordSignals/);
  assert.match(reconcileSource, /recordSignalDeliveryAttempt/);
});

test("fresh signal with no attempt is recovered after initial delivery grace", () => {
  assert.equal(discordRecoveryDecision({ signal: signal("manifested", 120), now: NOW }).recover, true);
});

test("provider-attempted stale live-now signals are never retried outside their strict freshness window", () => {
  const attemptedAt = NOW - 301;
  const lastAttempt = { result: "failed", detail: "Discord delivery failed (500)", attemptedAt };
  const manifested = discordRecoveryDecision({ signal: signal("manifested", 301), lastAttempt, now: NOW });
  const echo = discordRecoveryDecision({ signal: signal("echo", 301), lastAttempt, now: NOW });
  assert.deepEqual([manifested.recover, manifested.reason], [false, "stale"]);
  assert.deepEqual([echo.recover, echo.reason], [false, "stale"]);
});

test("never-attempted Echo survives a short process/deploy gap as a durable delivery obligation", () => {
  const echo = discordRecoveryDecision({ signal: signal("echo", 301), now: NOW });
  assert.deepEqual([echo.recover, echo.reason], [true, "no_attempt"]);
});

test("failed delivery can retry only after backoff while signal remains fresh", () => {
  const tooSoon = discordRecoveryDecision({
    signal: signal("manifested", 240),
    lastAttempt: { result: "failed", detail: "Discord delivery failed (500)", attemptedAt: NOW - 60 },
    now: NOW,
  });
  assert.deepEqual([tooSoon.recover, tooSoon.reason], [false, "retry_backoff"]);

  const retry = discordRecoveryDecision({
    signal: signal("whisper", 600),
    lastAttempt: { result: "failed", detail: "Discord delivery failed (500)", attemptedAt: NOW - 301 },
    now: NOW,
  });
  assert.deepEqual([retry.recover, retry.reason], [true, "retryable_attempt"]);
});

test("configuration-missing skips are retryable but deliberate disabled policy is terminal", () => {
  const missingChannel = discordRecoveryDecision({
    signal: signal("whisper", 600),
    lastAttempt: { result: "skipped", detail: "missing_lifecycle_channel_id", attemptedAt: NOW - 301 },
    now: NOW,
  });
  const disabled = discordRecoveryDecision({
    signal: signal("whisper", 600),
    lastAttempt: { result: "skipped", detail: "disabled", attemptedAt: NOW - 301 },
    now: NOW,
  });
  assert.deepEqual([missingChannel.recover, missingChannel.reason], [true, "retryable_attempt"]);
  assert.deepEqual([disabled.recover, disabled.reason], [false, "terminal_attempt"]);
});

test("delivery reconciliation runs independently of retailer scans", () => {
  assert.match(serverSource, /reconcileMissingDiscordDeliveries/);
  assert.match(serverSource, /DISCORD_DELIVERY_RECONCILE_INTERVAL_MS = 60 \* 1000/);
  assert.match(serverSource, /void reconcileDiscordDeliveries\(\)/);
  assert.match(serverSource, /setInterval\(reconcileDiscordDeliveries, DISCORD_DELIVERY_RECONCILE_INTERVAL_MS\)/);
});
