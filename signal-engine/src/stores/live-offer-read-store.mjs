import { DEFAULT_RETAILER_STALE_AFTER_SECONDS } from "./health-staleness.mjs";

const MAX_FUTURE_CLOCK_SKEW_SECONDS = 300;
export const MIN_LIVE_STOCK_CONFIDENCE = 0.9;

function liveRetailerIds(rows = []) {
  return new Set(
    rows
      .filter((row) => row?.healthy === true && row?.stale !== true)
      .map((row) => String(row?.id || "").trim())
      .filter(Boolean),
  );
}

function currentEpoch(now) {
  const value = typeof now === "function" ? Number(now()) : Number(now);
  return Number.isFinite(value) && value > 0 ? value : Math.floor(Date.now() / 1000);
}

export function freshOfferObservation(offer, {
  now = () => Math.floor(Date.now() / 1000),
  staleAfterSeconds = DEFAULT_RETAILER_STALE_AFTER_SECONDS,
} = {}) {
  const observedAt = Number(offer?.lastSeenAt);
  if (!Number.isFinite(observedAt) || observedAt <= 0) return false;

  const ageSeconds = currentEpoch(now) - observedAt;
  if (!Number.isFinite(ageSeconds) || ageSeconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS) return false;
  const safeThreshold = Math.max(60, Number(staleAfterSeconds) || DEFAULT_RETAILER_STALE_AFTER_SECONDS);
  return Math.max(0, ageSeconds) <= safeThreshold;
}

export function trustedStockObservation(offer, {
  minStockConfidence = MIN_LIVE_STOCK_CONFIDENCE,
} = {}) {
  const confidence = offer?.stockConfidence;
  // Missing confidence preserves the existing canonical behavior used by hosted
  // FateFind: absence of a score is not treated as low confidence. When a source
  // explicitly supplies a confidence score, weak evidence must fail closed.
  if (confidence === null || confidence === undefined || confidence === "") return true;
  const numeric = Number(confidence);
  if (!Number.isFinite(numeric)) return false;
  return numeric >= minStockConfidence;
}

/**
 * Consumer-facing offer reads must never treat preserved last-good catalogue
 * rows as live availability merely because their retailer is currently healthy.
 *
 * The underlying store remains untouched for monitoring/history. This proxy
 * only filters listOffers(), requiring ALL of:
 * - an effectively healthy, non-stale retailer;
 * - an individually fresh offer observation under the canonical 30-minute rule; and
 * - no explicit weak stock-confidence evidence (< 0.90).
 *
 * Missing/invalid observation times fail closed. Missing stock confidence keeps
 * existing behavior; only an explicit weak/invalid confidence score is rejected.
 * A small future-clock tolerance mirrors hosted FateFind observation trust without
 * allowing far-future rows. If retailer health cannot be read, offer reads fail
 * closed to an empty list.
 */
export function createLiveOfferReadStore(store, {
  now = () => Math.floor(Date.now() / 1000),
  offerStaleAfterSeconds = DEFAULT_RETAILER_STALE_AFTER_SECONDS,
  minStockConfidence = MIN_LIVE_STOCK_CONFIDENCE,
} = {}) {
  if (!store || typeof store.listOffers !== "function" || typeof store.listRetailers !== "function") {
    throw new TypeError("createLiveOfferReadStore requires listOffers and listRetailers");
  }

  const listOffers = async (options) => {
    try {
      const [offers, retailers] = await Promise.all([
        store.listOffers(options),
        store.listRetailers(),
      ]);
      const liveIds = liveRetailerIds(retailers);
      const observedNow = currentEpoch(now);
      return (Array.isArray(offers) ? offers : []).filter((offer) =>
        liveIds.has(String(offer?.retailerId || ""))
        && freshOfferObservation(offer, { now: observedNow, staleAfterSeconds: offerStaleAfterSeconds })
        && trustedStockObservation(offer, { minStockConfidence }));
    } catch {
      return [];
    }
  };

  return new Proxy(store, {
    get(target, property) {
      if (property === "listOffers") return listOffers;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const __test = { liveRetailerIds, currentEpoch, MAX_FUTURE_CLOCK_SKEW_SECONDS };