import { dispatchDiscordSignals } from "../notifications/discord.mjs";
import { dispatchSignalDeliveryOutbox } from "../notifications/signal-outbox.mjs";
import { recordSignalDeliveryAttempt } from "../telemetry/signal-delivery.mjs";
import { persistCanonicalSignals } from "../stores/canonical-signal-ledger.mjs";
import { stableId } from "./normalize.mjs";
import { isPrimaryDropRetailer, signalCapabilities } from "./signal-policy.mjs";

const ECHO_STATES = new Set(["queue", "security", "access_blocked"]);
const CONTEXT_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const CONTEXT_STATES = ["whisper", "manifested", "vanished"];

function confidenceFor(state) {
  if (state === "queue") return 0.95;
  if (state === "security") return 0.85;
  return 0.65;
}

function reasonFor(state) {
  if (state === "queue") return "Retailer queue / traffic-control state changed. Get ready; attached product context is recent retailer activity only and confirmed stock is not claimed yet.";
  if (state === "security") return "Retailer security / challenge behaviour changed. Get ready; attached product context is recent retailer activity only and confirmed stock is not claimed yet.";
  return "Retailer access-control behaviour changed. Attached product context is recent retailer activity only; treat this as readiness intelligence, not confirmed stock.";
}

async function appendSignals(store, signals) {
  if (!signals.length) return;
  if (typeof store.appendCanonicalSignals === "function") {
    return store.appendCanonicalSignals(signals);
  }
  if (typeof store.appendSignals === "function") {
    await store.appendSignals(signals);
    return;
  }
  if (typeof store.pool === "function") {
    const pool = await store.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await persistCanonicalSignals(client, signals);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("Store cannot append readiness signals");
}

function readinessEventFor({ retailer, state, previousState, observedAt, evidence }) {
  return {
    id: stableId("evt", "retailer_readiness", retailer.id, state, String(observedAt)),
    kind: "retailer_readiness",
    occurredAt: observedAt,
    evidence: {
      lifecycle: "echo",
      readinessState: state,
      previousState,
      observedAt,
      retailer: {
        id: retailer.id,
        name: retailer.name,
      },
      evidence: Array.isArray(evidence) ? evidence : [],
    },
  };
}

async function persistReadinessEvent(store, payload) {
  const event = readinessEventFor(payload);
  if (typeof store.appendSignalEvent === "function") {
    await store.appendSignalEvent(event);
    return { recorded: true, event };
  }
  if (typeof store.pool === "function") {
    const pool = await store.pool();
    await pool.query(
      `INSERT INTO fatedrop_signal_events
        (id,kind,product_identity_id,offer_id,retailer_id,location_id,occurred_at,evidence_json)
       VALUES ($1,$2,NULL,NULL,NULL,NULL,$3,$4::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.kind, event.occurredAt, JSON.stringify(event.evidence)],
    );
    return { recorded: true, event };
  }
  return { recorded: false, reason: "readiness_event_store_unavailable", event };
}

async function safePersistReadinessEvent(store, payload) {
  try {
    return await persistReadinessEvent(store, payload);
  } catch (error) {
    console.error("[echo] readiness event persistence failed", {
      retailerId: payload?.retailer?.id,
      state: payload?.state,
      error: String(error?.message || error),
    });
    return {
      recorded: false,
      reason: "readiness_event_persistence_failed",
      error: String(error?.message || error),
      event: readinessEventFor(payload),
    };
  }
}

function distinctProductContexts(signals) {
  const byProduct = new Map();
  for (const signal of signals || []) {
    if (!signal?.productId || !signal?.offerId || byProduct.has(signal.productId)) continue;
    byProduct.set(signal.productId, signal);
  }
  return [...byProduct.values()].slice(0, 10);
}

export async function recordRetailerReadiness({ retailer, store, state, previousState = null, observedAt = Math.floor(Date.now() / 1000), evidence = [] }) {
  if (!ECHO_STATES.has(state)) return { accepted: false, reason: "not_echo_state", signals: [], discord: { sent: 0, skipped: 0, failed: 0, errors: [] } };
  if (!isPrimaryDropRetailer(retailer?.id)) {
    return { accepted: true, reason: "market_retailer_readiness_suppressed", readinessState: state, previousState, productContexts: 0, signals: [], discord: { sent: 0, skipped: 0, failed: 0, errors: [] } };
  }

  // Persist the retailer-level readiness observation independently from product-linked
  // Echo alerts. A real queue/security/access event must remain auditable even when
  // no recent product context exists, and it must never require a fake product/offer FK.
  const readinessEvent = await safePersistReadinessEvent(store, {
    retailer,
    state,
    previousState,
    observedAt,
    evidence,
  });

  // Echo describes retailer readiness rather than stock. The persisted signal schema still
  // requires a real product/offer context, so use recent evidence from the same retailer.
  // Context never upgrades the readiness event into a stock claim.
  const recentContextSignals = await store.listSignals({
    states: CONTEXT_STATES,
    retailerIds: [retailer.id],
    since: Math.max(0, observedAt - CONTEXT_LOOKBACK_SECONDS),
    limit: 250,
  });
  const contexts = distinctProductContexts(recentContextSignals);

  const policy = signalCapabilities(retailer.id);
  const signals = contexts.map((context) => ({
    ...context,
    id: stableId("sig", context.offerId, "echo", state, String(observedAt)),
    state: "echo",
    kind: state,
    alertClass: policy.alertClass,
    signalCapabilities: policy,
    confidence: confidenceFor(state),
    detectedAt: observedAt,
    previousStockStatus: context.stockStatus ?? null,
    reason: reasonFor(state),
    evidence: [
      { kind: "signal_kind", value: state, lifecycle: "echo", observedAt },
      { kind: "signal_alert_class", value: policy.alertClass, observedAt },
      { kind: "retailer_readiness", state, previousState, observedAt, readinessEventId: readinessEvent.event?.id || null },
      { kind: "echo_product_context", sourceState: context.state, sourceSignalId: context.id, sourceDetectedAt: context.detectedAt },
      ...(Array.isArray(evidence) ? evidence : []),
      ...(Array.isArray(context.evidence) ? context.evidence : []),
    ],
    target: {
      type: "product",
      productId: context.productId,
      offerId: context.offerId,
      retailerId: retailer.id,
      productUrl: context.url,
      query: context.title,
    },
  }));

  const persistence = await appendSignals(store, signals);
  const acceptedIds = Array.isArray(persistence?.acceptedSignalIds)
    ? new Set(persistence.acceptedSignalIds)
    : null;
  const canonicalSignals = acceptedIds ? signals.filter((signal) => acceptedIds.has(signal.id)) : signals;
  const discord = canonicalSignals.length
    ? (typeof store?.pool === "function"
      ? await dispatchSignalDeliveryOutbox(store, { limit: Math.max(25, canonicalSignals.length) }).then((outbox) => ({
        sent: outbox.sent,
        skipped: outbox.suppressed,
        failed: outbox.retryable + outbox.unknown + outbox.deadLetter,
        errors: outbox.errors,
        outbox,
      }))
      : await dispatchDiscordSignals(canonicalSignals, {
        onDeliveryAttempt: (attempt) => recordSignalDeliveryAttempt(store, attempt),
      }))
    : { sent: 0, skipped: 0, failed: 0, errors: [] };

  return {
    accepted: true,
    readinessState: state,
    previousState,
    readinessEvent,
    productContexts: canonicalSignals.length,
    reason: canonicalSignals.length ? "echo_emitted" : "no_recent_retailer_product_context",
    signals: canonicalSignals,
    discord,
  };
}
