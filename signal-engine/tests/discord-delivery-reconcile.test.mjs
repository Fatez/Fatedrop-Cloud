import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { discordRecoveryDecision } from "../src/notifications/discord-reconcile.mjs";

const reconcileSource = await readFile(new URL("../src/notifications/discord-reconcile.mjs", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

const NOW = 2_000_000;
const signal = (state, ageSeconds) => ({ id: `sig_${state}`, state, detectedAt: NOW - ageSeconds });

test("Discord recovery consumes explicit outbox obligations and never infers legacy signal replays", () => {
  assert.match(reconcileSource, /dispatchSignalDeliveryOutbox/);
  assert.match(reconcileSource, /never infers obligations from historical fatedrop_signals/);
  assert.doesNotMatch(reconcileSource, /FROM fatedrop_signals/);
  assert.match(reconcileSource, /DEFAULT_GRACE_SECONDS = 90/);
  assert.match(reconcileSource, /DEFAULT_RETRY_DELAY_SECONDS = 5 \* 60/);
  assert.match(reconcileSource, /RATE_LIMIT_RETRY_DELAY_SECONDS = 60/);
  assert.match(reconcileSource, /manifested: 5 \* 60/);
  assert.match(reconcileSource, /echo: 5 \* 60/);
  assert.match(reconcileSource, /DEFAULT_BATCH_LIMIT = 25/);
  assert.doesNotMatch(reconcileSource, /dispatchDiscordSignals/);
  assert.doesNotMatch(reconcileSource, /recordSignalDeliveryAttempt/);
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

test("Discord rate limits retry on the next reconcile cycle and retain the longer delivery-obligation window", () => {
  const tooSoon = discordRecoveryDecision({
    signal: signal("whisper", 16 * 60),
    lastAttempt: { result: "failed", detail: "Discord rate limited for 0.3s", attemptedAt: NOW - 30 },
    now: NOW,
  });
  assert.deepEqual([tooSoon.recover, tooSoon.reason], [false, "retry_backoff"]);
  assert.equal(tooSoon.maxAgeSeconds, 20 * 60);

  const retry = discordRecoveryDecision({
    signal: signal("whisper", 16 * 60),
    lastAttempt: { result: "failed", detail: "Discord delivery failed (429)", attemptedAt: NOW - 61 },
    now: NOW,
  });
  assert.deepEqual([retry.recover, retry.reason], [true, "rate_limit_retry"]);
  assert.equal(retry.maxAgeSeconds, 20 * 60);
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
