import { dispatchDiscordSignals } from "./discord.mjs";
import { recordSignalDeliveryAttempt } from "../telemetry/signal-delivery.mjs";
import { discordEligibleSignalSqlFilter, signalInterruptEligible } from "../core/signal-visibility-policy.mjs";

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
const LOCK_NAME = "fatedrop:discord-delivery-reconcile";

function dbSignal(row) {
  return {
    id: row.id,
    state: row.state,
    productId: row.product_id,
    offerId: row.offer_id,
    retailerId: row.retailer_id,
    retailerName: row.retailer_name,
    title: row.title,
    productType: row.product_type,
    url: row.url,
    imageUrl: row.image_url,
    pricePence: row.price_pence,
    rrpPence: row.rrp_pence,
    postagePence: row.postage_pence,
    deliveredPricePence: row.delivered_price_pence,
    markupPercent: row.markup_percent == null ? null : Number(row.markup_percent),
    stockStatus: row.stock_status,
    previousStockStatus: row.previous_stock_status,
    confidence: row.confidence == null ? null : Number(row.confidence),
    detectedAt: Number(row.detected_at),
    reason: row.reason,
    evidence: row.evidence || [],
  };
}

function dbLastAttempt(row) {
  if (!row.last_delivery_result) return null;
  return {
    result: row.last_delivery_result,
    detail: row.last_delivery_detail || "",
    attemptedAt: Number(row.last_delivery_attempted_at),
  };
}

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
  graceSeconds = DEFAULT_GRACE_SECONDS,
  retryDelaySeconds = DEFAULT_RETRY_DELAY_SECONDS,
  maxAgeByState = DEFAULT_MAX_RECOVERY_AGE_SECONDS,
  orphanMaxAgeByState = DEFAULT_ORPHAN_MAX_RECOVERY_AGE_SECONDS,
  limit = DEFAULT_BATCH_LIMIT,
} = {}) {
  if (!store || typeof store.pool !== "function") {
    return { supported: false, recovered: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  }

  const pool = await store.pool();
  const client = await pool.connect();
  let locked = false;

  try {
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [LOCK_NAME],
    );
    locked = Boolean(lock.rows[0]?.acquired);
    if (!locked) {
      return { supported: true, locked: false, recovered: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
    }

    const safeGrace = Math.max(30, Math.min(10 * 60, Math.trunc(graceSeconds)));
    const safeRetryDelay = Math.max(60, Math.min(30 * 60, Math.trunc(retryDelaySeconds)));
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const maximumRecoveryAge = Math.max(
      ...LIFECYCLE_STATES.map((state) => Number(maxAgeByState?.[state]) || DEFAULT_MAX_RECOVERY_AGE_SECONDS[state]),
      ...LIFECYCLE_STATES.map((state) => Number(orphanMaxAgeByState?.[state]) || DEFAULT_ORPHAN_MAX_RECOVERY_AGE_SECONDS[state]),
    );
    const oldest = Math.max(0, now - maximumRecoveryAge);
    const newest = Math.max(0, now - safeGrace);
    const candidateLimit = Math.min(800, Math.max(200, safeLimit * 8));

    const { rows } = await client.query(
      `SELECT s.*,
              last_attempt.result AS last_delivery_result,
              COALESCE(last_attempt.detail,'') AS last_delivery_detail,
              last_attempt.attempted_at AS last_delivery_attempted_at
       FROM fatedrop_signals s
       LEFT JOIN LATERAL (
         SELECT d.result,d.detail,d.attempted_at
         FROM fatedrop_signal_delivery_attempts d
         WHERE d.signal_id=s.id AND d.channel='discord'
         ORDER BY d.attempted_at DESC
         LIMIT 1
       ) last_attempt ON true
       WHERE s.detected_at >= $1
         AND s.detected_at <= $2
         AND s.state = ANY($3)
         AND ${discordEligibleSignalSqlFilter("s")}
         AND NOT EXISTS (
           SELECT 1
           FROM fatedrop_signal_delivery_attempts delivered
           WHERE delivered.signal_id=s.id
             AND delivered.channel='discord'
             AND delivered.result='sent'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM fatedrop_signals newer
           WHERE newer.id <> s.id
             AND newer.retailer_id = s.retailer_id
             AND newer.state = ANY($3)
             AND newer.detected_at > s.detected_at
             AND (
               (s.offer_id IS NOT NULL AND newer.offer_id = s.offer_id)
               OR (
                 s.offer_id IS NULL
                 AND s.product_id IS NOT NULL
                 AND newer.offer_id IS NULL
                 AND newer.product_id = s.product_id
               )
             )
         )
       ORDER BY
         CASE WHEN last_attempt.result IS NULL THEN 0 ELSE 1 END ASC,
         s.detected_at ASC,
         s.id ASC
       LIMIT $4`,
      [oldest, newest, LIFECYCLE_STATES, candidateLimit],
    );

    const recoverable = rows
      .map((row) => ({ signal: dbSignal(row), lastAttempt: dbLastAttempt(row) }))
      .filter(({ signal, lastAttempt }) => discordRecoveryDecision({
        signal,
        lastAttempt,
        now,
        graceSeconds: safeGrace,
        retryDelaySeconds: safeRetryDelay,
        maxAgeByState,
        orphanMaxAgeByState,
      }).recover)
      .slice(0, safeLimit);

    const signals = recoverable.map(({ signal }) => signal);
    if (!signals.length) {
      return { supported: true, locked: true, recovered: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
    }

    const discord = await dispatchDiscordSignals(signals, {
      onDeliveryAttempt: (attempt) => recordSignalDeliveryAttempt(store, attempt),
    });

    return {
      supported: true,
      locked: true,
      recovered: signals.length,
      signalIds: signals.map((signal) => signal.id),
      ...discord,
    };
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_NAME]);
      } catch {}
    }
    client.release();
  }
}
