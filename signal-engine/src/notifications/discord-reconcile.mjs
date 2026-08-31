import { signalInterruptEligible } from "../core/signal-visibility-policy.mjs";
import { dispatchSignalDeliveryOutbox } from "./signal-outbox.mjs";

const LIFECYCLE_STATES = ["whisper", "echo", "manifested", "vanished"];
const DEFAULT_GRACE_SECONDS = 90;
const DEFAULT_RETRY_DELAY_SECONDS = 5 * 60;
const RATE_LIMIT_RETRY_DELAY_SECONDS = 60;
const DEFAULT_BATCH_LIMIT = 25;
const DEFAULT_MAX_RECOVERY_AGE_SECONDS = Object.freeze({
  whisper: 15 * 60,
  echo: 5 * 60,
  manifested: 5 * 60,
  vanished: 15 * 60,
});
// A canonical signal with no delivery attempt at all is a different failure class
// from a provider failure. It may have been persisted immediately before a hard
// scan deadline, process restart or deployment. Keep these obligations alive
// longer, but only while the signal remains the latest lifecycle event for its
// offer (the SQL candidate query suppresses superseded events).
const DEFAULT_ORPHAN_MAX_RECOVERY_AGE_SECONDS = Object.freeze({
  whisper: 20 * 60,
  echo: 60 * 60,
  manifested: 15 * 60,
  vanished: 30 * 60,
});
const RETRYABLE_SKIPPED_DETAILS = new Set(["missing_bot_token", "missing_lifecycle_channel_id"]);

function retryableAttempt(attempt) {
  if (!attempt) return true;
  if (attempt.result === "failed") return true;
  return attempt.result === "skipped" && RETRYABLE_SKIPPED_DETAILS.has(attempt.detail);
}

function rateLimitedAttempt(attempt) {
  if (!attempt || attempt.result !== "failed") return false;
  const detail = String(attempt.detail || "").toLowerCase();
  return detail.includes("rate limit") || detail.includes("rate_limited") || detail.includes("(429)");
}

function boundedAge(value, fallback, safeGrace) {
  return Math.max(safeGrace, Number(value) || fallback);
}

export function discordRecoveryDecision({
  signal,
  lastAttempt = null,
  now = Math.floor(Date.now() / 1000),
  graceSeconds = DEFAULT_GRACE_SECONDS,
  retryDelaySeconds = DEFAULT_RETRY_DELAY_SECONDS,
  maxAgeByState = DEFAULT_MAX_RECOVERY_AGE_SECONDS,
  orphanMaxAgeByState = DEFAULT_ORPHAN_MAX_RECOVERY_AGE_SECONDS,
} = {}) {
  const state = String(signal?.state || "").toLowerCase();
  if (!LIFECYCLE_STATES.includes(state)) return { recover: false, reason: "unsupported_state" };
  if (!signalInterruptEligible(signal)) return { recover: false, reason: "policy_not_interrupt_eligible" };
  const detectedAt = Number(signal?.detectedAt);
  if (!Number.isFinite(detectedAt) || detectedAt <= 0) return { recover: false, reason: "invalid_detected_at" };

  const ageSeconds = Math.max(0, now - detectedAt);
  const safeGrace = Math.max(30, Math.min(10 * 60, Math.trunc(graceSeconds)));
  const normalMaxAgeSeconds = boundedAge(
    maxAgeByState?.[state],
    DEFAULT_MAX_RECOVERY_AGE_SECONDS[state],
    safeGrace,
  );
  const orphanMaxAgeSeconds = boundedAge(
    orphanMaxAgeByState?.[state],
    DEFAULT_ORPHAN_MAX_RECOVERY_AGE_SECONDS[state],
    safeGrace,
  );
  const providerRateLimited = rateLimitedAttempt(lastAttempt);
  // Discord 429 is a provider-capacity failure, not evidence that the signal is stale.
  // Keep that persisted delivery obligation alive for the longer orphan window. The
  // candidate SQL still suppresses it immediately if a newer lifecycle event exists.
  const maxAgeSeconds = !lastAttempt || providerRateLimited ? orphanMaxAgeSeconds : normalMaxAgeSeconds;

  if (ageSeconds < safeGrace) return { recover: false, reason: "initial_delivery_grace", ageSeconds, maxAgeSeconds };
  if (ageSeconds > maxAgeSeconds) {
    return {
      recover: false,
      reason: lastAttempt ? "stale" : "orphan_stale",
      ageSeconds,
      maxAgeSeconds,
    };
  }

  if (!lastAttempt) return { recover: true, reason: "no_attempt", ageSeconds, maxAgeSeconds };
  if (lastAttempt.result === "sent") return { recover: false, reason: "already_sent", ageSeconds, maxAgeSeconds };
  if (!retryableAttempt(lastAttempt)) return { recover: false, reason: "terminal_attempt", ageSeconds, maxAgeSeconds };

  const attemptedAt = Number(lastAttempt.attemptedAt);
  const configuredRetryDelay = Math.max(60, Math.min(30 * 60, Math.trunc(retryDelaySeconds)));
  const safeRetryDelay = providerRateLimited ? Math.min(configuredRetryDelay, RATE_LIMIT_RETRY_DELAY_SECONDS) : configuredRetryDelay;
  if (Number.isFinite(attemptedAt) && now - attemptedAt < safeRetryDelay) {
    return { recover: false, reason: "retry_backoff", ageSeconds, maxAgeSeconds };
  }
  return {
    recover: true,
    reason: providerRateLimited ? "rate_limit_retry" : "retryable_attempt",
    ageSeconds,
    maxAgeSeconds,
  };
}

export async function reconcileMissingDiscordDeliveries({
  store,
  now = Math.floor(Date.now() / 1000),
  limit = DEFAULT_BATCH_LIMIT,
} = {}) {
  if (!store || typeof store.pool !== "function") {
    return { supported: false, recovered: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  }
  // Recovery now consumes only explicit, transactionally-created outbox rows.
  // It never infers obligations from historical fatedrop_signals, which prevents
  // a deployment from replaying legacy Whisper orphans.
  const outbox = await dispatchSignalDeliveryOutbox(store, { now, limit });
  return {
    supported: outbox.supported,
    locked: true,
    recovered: outbox.claimed,
    sent: outbox.sent,
    skipped: outbox.suppressed,
    failed: outbox.retryable + outbox.unknown + outbox.deadLetter,
    errors: outbox.errors,
    outbox,
  };
}
