import { SignalState, StockStatus, isPurchasable } from "./model.mjs";
import { markupPercent, stableId } from "./normalize.mjs";

export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  if (isBaseline) return null;

  const previousStatus = previousOffer?.stockStatus ?? null;
  const currentStatus = currentOffer.stockStatus;
  const wasPurchasable = previousOffer ? isPurchasable(previousStatus) : false;
  const nowPurchasable = isPurchasable(currentStatus);

  let state = null;
  let reason = null;

  // FINAL FATEDROP LIFECYCLE CONTRACT:
  // WHISPER = product/catalogue movement before a confirmed live event.
  // ECHO = retailer traffic/security/queue readiness intelligence (emitted by infrastructure probes, not catalogue stock transitions).
  // MANIFESTED = confirmed purchasable availability/restock.
  // VANISHED = previously purchasable availability lost.
  if (!previousOffer) {
    if (nowPurchasable) {
      state = SignalState.MANIFESTED;
      reason = "New catalogue product discovered and verified purchasable";
    } else if ([StockStatus.PREORDER, StockStatus.COMING_SOON, StockStatus.OUT_OF_STOCK].includes(currentStatus)) {
      state = SignalState.WHISPER;
      reason = "Product/catalogue activity observed before verified availability";
    }
  } else if (!wasPurchasable && nowPurchasable) {
    state = SignalState.MANIFESTED;
    reason = previousOffer?.everAvailableAt
      ? "Previously available product returned to verified availability"
      : "Availability became verified";
  } else if (wasPurchasable && !nowPurchasable) {
    state = SignalState.VANISHED;
    reason = "Previously purchasable product is no longer verified available";
  } else if (previousStatus !== currentStatus && !nowPurchasable) {
    state = SignalState.WHISPER;
    reason = "Product/catalogue state changed before verified availability";
  }

  if (!state) return null;
  const id = stableId("sig", currentOffer.offerId, state, String(now), currentStatus);
  const deliveredPricePence = currentOffer.postagePence == null || currentOffer.pricePence == null
    ? null
    : currentOffer.pricePence + currentOffer.postagePence;

  return {
    id,
    state,
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
    evidence: currentOffer.evidence ?? [],
  };
}
