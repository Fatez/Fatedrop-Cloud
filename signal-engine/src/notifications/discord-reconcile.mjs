import { dispatchDiscordSignals } from "./discord.mjs";
import { recordSignalDeliveryAttempt } from "../telemetry/signal-delivery.mjs";

const LIFECYCLE_STATES = ["whisper", "echo", "manifested", "vanished"];
const DEFAULT_GRACE_SECONDS = 90;
const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60;
const DEFAULT_BATCH_LIMIT = 25;
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

export async function reconcileMissingDiscordDeliveries({
  store,
  now = Math.floor(Date.now() / 1000),
  graceSeconds = DEFAULT_GRACE_SECONDS,
  lookbackSeconds = DEFAULT_LOOKBACK_SECONDS,
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
    const safeLookback = Math.max(safeGrace, Math.min(7 * 24 * 60 * 60, Math.trunc(lookbackSeconds)));
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const oldest = Math.max(0, now - safeLookback);
    const newest = Math.max(0, now - safeGrace);

    const { rows } = await client.query(
      `SELECT s.*
       FROM fatedrop_signals s
       WHERE s.detected_at >= $1
         AND s.detected_at <= $2
         AND s.state = ANY($3)
         AND NOT EXISTS (
           SELECT 1
           FROM fatedrop_signal_delivery_attempts d
           WHERE d.signal_id=s.id
             AND d.channel='discord'
         )
       ORDER BY s.detected_at ASC, s.id ASC
       LIMIT $4`,
      [oldest, newest, LIFECYCLE_STATES, safeLimit],
    );

    const signals = rows.map(dbSignal);
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
