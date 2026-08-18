import { SignalState, StockStatus, isPurchasable } from "./model.mjs";
import { markupPercent, stableId } from "./normalize.mjs";

export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  if (isBaseline) return null;

  const previousStatus = previousOffer?.stockStatus ?? null;
  const currentStatus = currentOffer.stockStatus;
  const wasPurchasable = previousOffer ? isPurchasable(previousStatus) : false;
  const nowPurchasable = isPurchasable(currentStatus);
  const everAvailable = Boolean(previousOffer?.everAvailableAt);

  let state = null;
  let reason = null;
  if (!previousOffer) {
    if (nowPurchasable) {
      state = SignalState.MANIFESTED;
      reason = "New catalogue product discovered and purchasable";
    } else if ([StockStatus.PREORDER, StockStatus.COMING_SOON, StockStatus.OUT_OF_STOCK].includes(currentStatus)) {
      state = SignalState.WHISPER;
      reason = "New catalogue product discovered before verified availability";
    }
  } else if (!wasPurchasable && nowPurchasable) {
    state = everAvailable ? SignalState.ECHO : SignalState.MANIFESTED;
    reason = everAvailable ? "Previously available product returned" : "Availability became verified";
  } else if (wasPurchasable && !nowPurchasable) {
    state = SignalState.VANISHED;
    reason = "Previously purchasable product is no longer verified available";
  } else if (
    previousStatus !== currentStatus &&
    !nowPurchasable &&
    [StockStatus.PREORDER, StockStatus.COMING_SOON].includes(currentStatus)
  ) {
    state = SignalState.WHISPER;
    reason = "Catalogue status changed before verified availability";
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
    evidence: currentOffer.evidence ?? [],
  };
}
