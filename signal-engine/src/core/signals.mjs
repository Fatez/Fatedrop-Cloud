import { SignalState, StockStatus, isPurchasable } from "./model.mjs";
import { markupPercent, stableId } from "./normalize.mjs";

function evidenceWithSignalKind(evidence, { kind, state, observedAt }) {
  return [
    ...(Array.isArray(evidence) ? evidence : []),
    { kind: "signal_kind", value: kind, lifecycle: state, observedAt },
  ];
}

export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  if (isBaseline) return null;

  const previousStatus = previousOffer?.stockStatus ?? null;
  const currentStatus = currentOffer.stockStatus;
  const wasPurchasable = previousOffer ? isPurchasable(previousStatus) : false;
  const nowPurchasable = isPurchasable(currentStatus);

  let state = null;
  let kind = null;
  let reason = null;

  // FINAL FATEDROP LIFECYCLE CONTRACT:
  // WHISPER = product/catalogue movement before a confirmed live event.
  // ECHO = retailer traffic/security/queue readiness intelligence (emitted by infrastructure probes, not catalogue stock transitions).
  // MANIFESTED = confirmed purchasable availability/restock.
  // VANISHED = previously purchasable availability lost.
  // `kind` records the exact cause while `state` remains the public four-stage lifecycle.
  if (!previousOffer) {
    if (nowPurchasable) {
      state = SignalState.MANIFESTED;
      kind = "new_listing_live";
      reason = "New catalogue product discovered and verified purchasable";
    } else if ([StockStatus.PREORDER, StockStatus.COMING_SOON, StockStatus.OUT_OF_STOCK].includes(currentStatus)) {
      state = SignalState.WHISPER;
      kind = "catalogue_new";
      reason = "Product/catalogue activity observed before verified availability";
    }
  } else if (!wasPurchasable && nowPurchasable) {
    state = SignalState.MANIFESTED;
    if (previousOffer?.everAvailableAt) {
      kind = "restock";
      reason = "Previously available product returned to verified availability";
    } else {
      kind = "availability_live";
      reason = "Availability became verified";
    }
  } else if (wasPurchasable && !nowPurchasable) {
    state = SignalState.VANISHED;
    kind = "sold_out";
    reason = "Previously purchasable product is no longer verified available";
  } else if (previousStatus !== currentStatus && !nowPurchasable) {
    state = SignalState.WHISPER;
    kind = "catalogue_state_change";
    reason = "Product/catalogue state changed before verified availability";
  }

  if (!state || !kind) return null;
  const id = stableId("sig", currentOffer.offerId, state, kind, String(now), currentStatus);
  const deliveredPricePence = currentOffer.postagePence == null || currentOffer.pricePence == null
    ? null
    : currentOffer.pricePence + currentOffer.postagePence;

  return {
    id,
    state,
    kind,
    productId: currentOffer.productId,
    offerId: currentOffer.offerId,
    retailerId: currentOffer.retailerId,
    retailerName: currentOffer.retailerName,
    title: currentOffer.title,
    productType: currentOffer.productType,
    url: currentOffer.url,
    imageUrl: currentOffer.imageUrl ?? null,
    pricePence: currentOffer.pricePence ?? null,
    rrpPence: currentOffer.rrpPence ?? null,
    postagePence: currentOffer.postagePence ?? null,
    deliveredPricePence,
    markupPercent: markupPercent(currentOffer.pricePence, currentOffer.rrpPence),
    stockStatus: currentStatus,
    previousStockStatus: previousStatus,
    confidence: currentOffer.stockConfidence ?? 0.5,
    detectedAt: now,
    reason,
    target: {
      type: "product",
      productId: currentOffer.productId,
      offerId: currentOffer.offerId,
      retailerId: currentOffer.retailerId,
      productUrl: currentOffer.url,
      query: currentOffer.title,
    },
    evidence: evidenceWithSignalKind(currentOffer.evidence, { kind, state, observedAt: now }),
  };
}
