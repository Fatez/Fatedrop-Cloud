import crypto from "node:crypto";
import { sendDiscordSignal } from "./discord.mjs";
import { stableId } from "../core/normalize.mjs";

const DEFAULT_LIMIT = 25;
const DEFAULT_LEASE_SECONDS = 2 * 60;
const MAX_ATTEMPTS = 6;

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

function retryAt(now, attemptNumber) {
  return now + Math.min(15 * 60, 30 * (2 ** Math.min(5, Math.max(0, attemptNumber - 1))));
}

function clipped(value, max = 1000) {
  const result = String(value ?? "").trim();
  return result ? result.slice(0, max) : null;
}

async function markExpiredClaims(pool, now) {
  const { rows } = await pool.query(
    `UPDATE fatedrop_signal_delivery_outbox
     SET state='outcome_unknown',lease_token=NULL,lease_expires_at=NULL,updated_at=$1,
         last_error='lease_expired_after_provider_boundary'
     WHERE state='claimed' AND lease_expires_at < $1
     RETURNING id,attempt_count`,
    [now],
  );
  for (const row of rows) {
    await pool.query(
      `INSERT INTO fatedrop_signal_delivery_outbox_attempts
        (id,outbox_id,attempt_number,started_at,completed_at,result,detail)
       VALUES ($1,$2,$3,$4,$4,'outcome_unknown','lease_expired_after_provider_boundary')
       ON CONFLICT (outbox_id,attempt_number) DO NOTHING`,
      [stableId("sda", row.id, String(row.attempt_count)), row.id, row.attempt_count, now],
    );
  }
  return rows.length;
}

async function expireStaleObligations(pool, now) {
  const { rows } = await pool.query(
    `UPDATE fatedrop_signal_delivery_outbox
     SET state='dead_letter',updated_at=$1,last_error='expired_before_delivery'
     WHERE state IN ('pending','retryable') AND expires_at < $1
     RETURNING id`,
    [now],
  );
  return rows.length;
}

async function suppressSupersededObligations(pool, now) {
  const { rows } = await pool.query(
    `UPDATE fatedrop_signal_delivery_outbox outbox
     SET state='suppressed',updated_at=$1,last_error='superseded_by_newer_episode_event'
     FROM fatedrop_stock_episode_events current_event,
          fatedrop_stock_episodes current_episode
     WHERE outbox.state IN ('pending','retryable')
       AND outbox.signal_id=current_event.signal_id
       AND current_event.episode_id=current_episode.id
       AND EXISTS (
         SELECT 1
         FROM fatedrop_stock_episode_events newer_event
         JOIN fatedrop_stock_episodes newer_episode ON newer_episode.id=newer_event.episode_id
         WHERE newer_episode.scope_type=current_episode.scope_type
           AND newer_episode.scope_key=current_episode.scope_key
           AND (
             newer_event.occurred_at > current_event.occurred_at
             OR (newer_event.occurred_at=current_event.occurred_at AND newer_event.id > current_event.id)
           )
           AND (
             newer_event.stage IN ('manifested','vanished')
             OR current_event.stage IN ('whisper','echo')
           )
       )
     RETURNING outbox.id`,
    [now],
  );
  return rows.length;
}

async function claimNext(pool, { now, leaseSeconds }) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = now + leaseSeconds;
  const { rows } = await pool.query(
    `WITH candidate AS (
       SELECT id
       FROM fatedrop_signal_delivery_outbox
       WHERE channel='discord'
         AND delivery_policy='interrupt'
         AND state IN ('pending','retryable')
         AND available_at <= $1
         AND expires_at >= $1
       ORDER BY available_at ASC,created_at ASC,id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE fatedrop_signal_delivery_outbox outbox
     SET state='claimed',attempt_count=outbox.attempt_count+1,lease_token=$2,lease_expires_at=$3,updated_at=$1
     FROM candidate
     WHERE outbox.id=candidate.id
     RETURNING outbox.*`,
    [now, leaseToken, leaseExpiresAt],
  );
  return rows[0] || null;
}

async function loadSignal(pool, signalId) {
  const { rows } = await pool.query("SELECT * FROM fatedrop_signals WHERE id=$1", [signalId]);
  return rows[0] ? dbSignal(rows[0]) : null;
}

function outcomeForError(error) {
  const status = Number(error?.status);
  const detail = clipped(error?.message || error) || "discord_provider_failure";
  if (!Number.isFinite(status)) {
    // No authoritative provider response means FateDrop cannot know whether the
    // provider accepted the request. Quarantine instead of blindly duplicating.
    return { state: "outcome_unknown", result: "outcome_unknown", detail };
  }
  if (status === 429 || status >= 500) {
    return { state: "retryable", result: "retryable_failure", detail };
  }
  return { state: "dead_letter", result: "terminal_failure", detail };
}

async function finishAttempt(pool, row, outcome, now) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT * FROM fatedrop_signal_delivery_outbox WHERE id=$1 FOR UPDATE",
      [row.id],
    );
    const claimed = current.rows[0];
    if (!claimed || claimed.state !== "claimed" || claimed.lease_token !== row.lease_token) {
      await client.query("ROLLBACK");
      return { recorded: false, reason: "claim_lost" };
    }

    const attemptId = stableId("sda", row.id, String(row.attempt_count));
    await client.query(
      `INSERT INTO fatedrop_signal_delivery_outbox_attempts
        (id,outbox_id,attempt_number,started_at,completed_at,result,provider_message_id,detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (outbox_id,attempt_number) DO NOTHING`,
      [attemptId, row.id, row.attempt_count, row.updated_at || now, now, outcome.result, outcome.providerMessageId || null, clipped(outcome.detail)],
    );

    const exhausted = outcome.state === "retryable" && row.attempt_count >= MAX_ATTEMPTS;
    const nextState = exhausted ? "dead_letter" : outcome.state;
    const nextAvailableAt = nextState === "retryable" ? retryAt(now, row.attempt_count) : row.available_at;
    const lastError = exhausted ? `attempts_exhausted:${clipped(outcome.detail) || "provider_failure"}` : clipped(outcome.detail);
    await client.query(
      `UPDATE fatedrop_signal_delivery_outbox
       SET state=$2,available_at=$3,lease_token=NULL,lease_expires_at=NULL,
           provider_message_id=COALESCE($4,provider_message_id),
           accepted_at=CASE WHEN $2='provider_accepted' THEN $5 ELSE accepted_at END,
           updated_at=$5,last_error=$6
       WHERE id=$1`,
      [row.id, nextState, nextAvailableAt, outcome.providerMessageId || null, now, nextState === "provider_accepted" ? null : lastError],
    );

    const legacyResult = nextState === "provider_accepted" ? "sent" : nextState === "suppressed" ? "skipped" : "failed";
    await client.query(
      `INSERT INTO fatedrop_signal_delivery_attempts
        (id,signal_id,channel,attempted_at,result,provider_message_id,detail)
       VALUES ($1,$2,'discord',$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [attemptId, row.signal_id, now, legacyResult, outcome.providerMessageId || null, clipped(outcome.detail)],
    );
    await client.query("COMMIT");
    return { recorded: true, state: nextState };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function deliverClaim(pool, row, { now, sendDiscordSignalFn, discordOptions }) {
  const signal = await loadSignal(pool, row.signal_id);
  if (!signal) {
    return finishAttempt(pool, row, {
      state: "dead_letter",
      result: "terminal_failure",
      detail: "canonical_signal_missing",
    }, now);
  }

  let outcome;
  try {
    const delivery = await sendDiscordSignalFn(signal, discordOptions);
    if (delivery.sent) {
      outcome = {
        state: "provider_accepted",
        result: "provider_accepted",
        providerMessageId: delivery.messageId || null,
        detail: delivery.channelId ? `channel_id:${delivery.channelId}` : null,
      };
    } else if (delivery.reason === "disabled") {
      outcome = { state: "suppressed", result: "suppressed", detail: "discord_disabled" };
    } else {
      outcome = { state: "retryable", result: "retryable_failure", detail: delivery.reason || "discord_not_configured" };
    }
  } catch (error) {
    outcome = outcomeForError(error);
  }
  return finishAttempt(pool, row, outcome, now);
}

export async function dispatchSignalDeliveryOutbox(store, {
  limit = DEFAULT_LIMIT,
  now = Math.floor(Date.now() / 1000),
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  sendDiscordSignalFn = sendDiscordSignal,
  discordOptions = {},
} = {}) {
  if (!store || typeof store.pool !== "function") {
    return { supported: false, claimed: 0, sent: 0, retryable: 0, suppressed: 0, unknown: 0, deadLetter: 0, errors: [] };
  }
  const pool = await store.pool();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const safeLease = Math.max(30, Math.min(10 * 60, Math.trunc(leaseSeconds)));
  const summary = {
    supported: true,
    claimed: 0,
    sent: 0,
    retryable: 0,
    suppressed: 0,
    unknown: 0,
    deadLetter: 0,
    expiredClaims: await markExpiredClaims(pool, now),
    expiredObligations: await expireStaleObligations(pool, now),
    supersededObligations: await suppressSupersededObligations(pool, now),
    errors: [],
  };

  for (let index = 0; index < safeLimit; index += 1) {
    const row = await claimNext(pool, { now, leaseSeconds: safeLease });
    if (!row) break;
    summary.claimed += 1;
    try {
      const result = await deliverClaim(pool, row, { now, sendDiscordSignalFn, discordOptions });
      if (result.state === "provider_accepted") summary.sent += 1;
      else if (result.state === "retryable") summary.retryable += 1;
      else if (result.state === "suppressed") summary.suppressed += 1;
      else if (result.state === "outcome_unknown") summary.unknown += 1;
      else if (result.state === "dead_letter") summary.deadLetter += 1;
    } catch (error) {
      summary.errors.push({ outboxId: row.id, error: clipped(error?.message || error) });
    }
  }
  return summary;
}
