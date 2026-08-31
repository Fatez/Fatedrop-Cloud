import { dispatchDiscordSignals } from "../notifications/discord.mjs";
import { dispatchSignalDeliveryOutbox } from "../notifications/signal-outbox.mjs";
import { recordSignalDeliveryAttempt } from "../telemetry/signal-delivery.mjs";
import { saveDiscoveryObservationBatch } from "../stores/discovery-observation-store.mjs";
import { processRetailerProducts } from "./engine.mjs";
import { discoveryBatchObservedAt, normalizeDiscoveryProduct } from "./discovery-observation.mjs";
import { stableId } from "./normalize.mjs";

function evidenceObservation(offer, observedAt) {
  return {
    id: stableId("obs", offer.offerId, String(observedAt), "discovery", String(offer.stockStatus), String(offer.pricePence)),
    offerId: offer.offerId,
    retailerId: offer.retailerId,
    observedAt,
    stockStatus: offer.stockStatus,
    stockConfidence: offer.stockConfidence,
    stockQuantity: offer.stockQuantity,
    pricePence: offer.pricePence,
    evidence: Array.isArray(offer.evidence) ? offer.evidence : [],
  };
}

function discoveryStore(store, capture, freshRetailerSkus) {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "isBaselineComplete") return async () => true;
      if (property === "saveScan") {
        return async (payload) => {
          const observations = [...(payload.observations || [])];
          const observedOfferIds = new Set(observations.map((item) => item.offerId));
          for (const offer of payload.offers || []) {
            if (observedOfferIds.has(offer.offerId)) continue;
            observations.push(evidenceObservation(offer, Number(offer.lastSeenAt || payload.completedAt)));
          }

          const freshSignals = (payload.signals || []).filter((signal) => freshRetailerSkus.has(signal.retailerSku));
          const persisted = await saveDiscoveryObservationBatch(target, {
            ...payload,
            observations,
            signals: freshSignals,
          });
          capture.insertedSignalIds = new Set(persisted.insertedSignalIds || []);
          capture.persistence = persisted;
          return persisted;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function dispatchCanonicalSignals(store, signals) {
  if (!signals.length) return { sent: 0, skipped: 0, failed: 0, errors: [] };
  if (typeof store?.pool === "function") {
    const outbox = await dispatchSignalDeliveryOutbox(store, { limit: Math.max(25, signals.length) });
    return {
      sent: outbox.sent,
      skipped: outbox.suppressed,
      failed: outbox.retryable + outbox.unknown + outbox.deadLetter,
      errors: outbox.errors,
      outbox,
    };
  }
  return dispatchDiscordSignals(signals, {
    onDeliveryAttempt: (attempt) => recordSignalDeliveryAttempt(store, attempt),
  });
}

export async function ingestRetailerDiscoveryObservations({
  retailer,
  store,
  observations,
  receivedAt = Math.floor(Date.now() / 1000),
  dispatchNotifications = true,
} = {}) {
  if (!retailer?.id) throw new Error("Discovery intake requires a canonical retailer");
  if (!Array.isArray(observations) || observations.length === 0) throw new Error("Discovery intake requires observations");
  if (observations.length > 250) throw new Error("Discovery intake accepts at most 250 observations per batch");

  const observedAt = discoveryBatchObservedAt(observations, receivedAt);
  const normalized = observations.map((item) => normalizeDiscoveryProduct(item, retailer, receivedAt));
  const freshRetailerSkus = new Set(normalized.filter((item) => item.discoveryFresh).map((item) => item.retailerSku));
  const capture = { insertedSignalIds: new Set(), persistence: null };
  const wrappedStore = discoveryStore(store, capture, freshRetailerSkus);

  const result = await processRetailerProducts({
    retailer,
    store: wrappedStore,
    rawProducts: normalized,
    now: observedAt,
    pagesScanned: 0,
    source: "discovery_observation",
    dispatchNotifications: false,
  });

  const canonicalSignals = (result.signals || []).filter((signal) => capture.insertedSignalIds.has(signal.id));
  const discord = dispatchNotifications
    ? await dispatchCanonicalSignals(store, canonicalSignals)
    : { sent: 0, skipped: 0, failed: 0, errors: [], deferred: canonicalSignals.length > 0 };

  return {
    ...result,
    source: "discovery_observation",
    received: observations.length,
    accepted: normalized.length,
    fresh: freshRetailerSkus.size,
    signalsCreated: canonicalSignals.length,
    signals: canonicalSignals,
    deduplicatedSignals: capture.persistence?.deduplicatedSignals || 0,
    catalogueHealthUpdated: false,
    discord,
  };
}
