import { dispatchDiscordSignals } from "../notifications/discord.mjs";
import { recordSignalDeliveryAttempt } from "../telemetry/signal-delivery.mjs";
import { stableId } from "./normalize.mjs";

const ECHO_STATES = new Set(["queue", "security", "access_blocked"]);
const LOOKBACK_SECONDS = 6 * 60 * 60;

function confidenceFor(state) {
  if (state === "queue") return 0.95;
  if (state === "security") return 0.85;
  return 0.65;
}

function reasonFor(state) {
  if (state === "queue") return "Retailer queue / traffic-control state changed. Get ready; confirmed stock is not claimed yet.";
  if (state === "security") return "Retailer security / challenge behaviour changed. Get ready; confirmed stock is not claimed yet.";
  return "Retailer access-control behaviour changed. Treat as readiness intelligence only; confirmed stock is not claimed.";
}

async function appendSignals(store, signals) {
  if (!signals.length) return;
  if (typeof store.appendSignals === "function") {
    await store.appendSignals(signals);
    return;
  }
  if (typeof store.pool === "function") {
    const pool = await store.pool();
    for (const s of signals) {
      await pool.query(`INSERT INTO fatedrop_signals (id,state,product_id,offer_id,retailer_id,retailer_name,title,product_type,url,image_url,price_pence,rrp_pence,postage_pence,delivered_price_pence,markup_percent,stock_status,previous_stock_status,confidence,detected_at,reason,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb) ON CONFLICT DO NOTHING`, [s.id,s.state,s.productId,s.offerId,s.retailerId,s.retailerName,s.title,s.productType,s.url,s.imageUrl,s.pricePence,s.rrpPence,s.postagePence,s.deliveredPricePence,s.markupPercent,s.stockStatus,s.previousStockStatus,s.confidence,s.detectedAt,s.reason,JSON.stringify(s.evidence)]);
    }
    return;
  }
  throw new Error("Store cannot append readiness signals");
}

export async function recordRetailerReadiness({ retailer, store, state, previousState = null, observedAt = Math.floor(Date.now() / 1000), evidence = [] }) {
  if (!ECHO_STATES.has(state)) return { accepted: false, reason: "not_echo_state", signals: [], discord: { sent: 0, skipped: 0, failed: 0, errors: [] } };

  // Echo must not invent a product relationship. It attaches only to products
  // that already produced a recent Whisper at this retailer. If there is no
  // product context, the infrastructure observation is accepted but no public
  // product-linked Echo is emitted.
  const recentWhispers = await store.listSignals({ states: ["whisper"], retailerIds: [retailer.id], since: Math.max(0, observedAt - LOOKBACK_SECONDS), limit: 50 });
  const byProduct = new Map();
  for (const whisper of recentWhispers) {
    if (!whisper.productId || !whisper.offerId || byProduct.has(whisper.productId)) continue;
    byProduct.set(whisper.productId, whisper);
  }

  const signals = [...byProduct.values()].slice(0, 10).map((whisper) => ({
    ...whisper,
    id: stableId("sig", whisper.offerId, "echo", state, String(observedAt)),
    state: "echo",
    confidence: confidenceFor(state),
    detectedAt: observedAt,
    previousStockStatus: whisper.stockStatus ?? null,
    reason: reasonFor(state),
    evidence: [
      ...(Array.isArray(whisper.evidence) ? whisper.evidence : []),
      { kind: "retailer_readiness", state, previousState, observedAt },
      ...(Array.isArray(evidence) ? evidence : []),
    ],
    target: {
      type: "product",
      productId: whisper.productId,
      offerId: whisper.offerId,
      retailerId: retailer.id,
      productUrl: whisper.url,
      query: whisper.title,
    },
  }));

  await appendSignals(store, signals);
  const discord = signals.length ? await dispatchDiscordSignals(signals, {
    onDeliveryAttempt: (attempt) => recordSignalDeliveryAttempt(store, attempt),
  }) : { sent: 0, skipped: 0, failed: 0, errors: [] };

  return {
    accepted: true,
    readinessState: state,
    previousState,
    productContexts: signals.length,
    reason: signals.length ? "echo_emitted" : "no_recent_whisper_product_context",
    signals,
    discord,
  };
}
