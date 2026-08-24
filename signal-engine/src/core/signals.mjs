import { SignalState, StockStatus, isPurchasable } from "./model.mjs";
import { markupPercent, stableId } from "./normalize.mjs";
import { signalCapabilities } from "./signal-policy.mjs";
import { classifyProductAlert } from "./product-alert-intelligence.mjs";

function signalEvidence(evidence, { kind, state, alertClass, retailerSku, observedAt, productAlertClassification }) {
  return [
    ...(Array.isArray(evidence) ? evidence : []),
    { kind: "signal_kind", value: kind, lifecycle: state, observedAt },
    { kind: "signal_alert_class", value: alertClass, observedAt },
    ...(productAlertClassification ? [{
      kind: "product_alert_classification",
      category: productAlertClassification.category,
      subcategory: productAlertClassification.subcategory,
      confidence: productAlertClassification.confidence,
      evidence: productAlertClassification.evidence,
      observedAt,
    }] : []),
    ...(retailerSku ? [{ kind: "retailer_sku", value: retailerSku, observedAt }] : []),
  ];
}

export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000), availabilityWindow = null }) {
  if (isBaseline) return null;

  const previousStatus = previousOffer?.stockStatus ?? null;
  const currentStatus = currentOffer.stockStatus;
  const wasPurchasable = previousOffer ? isPurchasable(previousStatus) : false;
  const nowPurchasable = isPurchasable(currentStatus);
  const policy = signalCapabilities(currentOffer.retailerId);

  let state = null;
  let kind = null;
  let reason = null;

  // FINAL FATEDROP LIFECYCLE CONTRACT:
  // WHISPER = new SKU/catalogue movement or meaningful pre-live state change.
  // ECHO = retailer readiness evidence such as queue/security/access changes.
  // MANIFESTED = verified purchasable availability/restock.
  // VANISHED = previously purchasable availability lost.
  // The lifecycle stays universal; alertClass controls Primary/RRP vs Market/Indie presentation downstream.
  if (!previousOffer) {
    if (nowPurchasable) {
      state = SignalState.MANIFESTED;
      kind = "new_listing_live";
      reason = "New retailer SKU discovered and verified purchasable";
    } else if ([StockStatus.PREORDER, StockStatus.COMING_SOON, StockStatus.OUT_OF_STOCK].includes(currentStatus)) {
      state = SignalState.WHISPER;
      kind = "catalogue_new";
      reason = "New retailer SKU/catalogue activity observed before verified availability";
    }
  } else if (!wasPurchasable && nowPurchasable) {
    state = SignalState.MANIFESTED;
    if (previousOffer?.everAvailableAt) {
      kind = "restock";
      reason = "Previously available retailer SKU returned to verified availability";
    } else {
      kind = "availability_live";
      reason = "Retailer SKU availability became verified";
    }
  } else if (wasPurchasable && !nowPurchasable) {
    // Public lifecycle continuity is strict: Vanished may only close a
    // previously published, still-open Manifested window for this offer.
    // Stock truth is still persisted by the engine when this returns null.
    if (!availabilityWindow?.manifestedSignalId) return null;
    state = SignalState.VANISHED;
    kind = "sold_out";
    reason = "Previously Manifested retailer SKU is no longer verified available";
  } else if (previousStatus !== currentStatus && !nowPurchasable) {
    state = SignalState.WHISPER;
    kind = "catalogue_state_change";
    reason = "Retailer SKU/catalogue state changed before verified availability";
  }

  if (!state || !kind) return null;
  const productAlertClassification = classifyProductAlert({ title: currentOffer.title, productType: currentOffer.productType });
  const id = stableId("sig", currentOffer.offerId, state, kind, String(now), currentStatus);
  const availabilityWindowId = state === SignalState.MANIFESTED
    ? stableId("avw", currentOffer.offerId, id)
    : state === SignalState.VANISHED
      ? availabilityWindow?.id || stableId("avw", currentOffer.offerId, availabilityWindow.manifestedSignalId)
      : null;
  const pairedManifestedSignalId = state === SignalState.VANISHED ? availabilityWindow?.manifestedSignalId || null : null;
  const availabilityEvidence = availabilityWindowId ? [{
    kind: "availability_window",
    value: availabilityWindowId,
    status: state === SignalState.MANIFESTED ? "opened" : "closed",
    manifestedSignalId: state === SignalState.MANIFESTED ? id : pairedManifestedSignalId,
    ...(state === SignalState.VANISHED ? { vanishedSignalId: id } : {}),
    observedAt: now,
  }] : [];
  const deliveredPricePence = currentOffer.postagePence == null || currentOffer.pricePence == null
    ? null
    : currentOffer.pricePence + currentOffer.postagePence;

  return {
    id,
    state,
    kind,
    alertClass: policy.alertClass,
    signalCapabilities: policy,
    productId: currentOffer.productId,
    offerId: currentOffer.offerId,
    retailerId: currentOffer.retailerId,
    retailerName: currentOffer.retailerName,
    retailerSku: currentOffer.retailerSku ?? null,
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
    productAlertClassification,
    availabilityWindowId,
    pairedManifestedSignalId,
    target: {
      type: "product",
      productId: currentOffer.productId,
      offerId: currentOffer.offerId,
      retailerId: currentOffer.retailerId,
      productUrl: currentOffer.url,
      query: currentOffer.title,
    },
    evidence: [
      ...signalEvidence(currentOffer.evidence, {
        kind,
        state,
        alertClass: policy.alertClass,
        retailerSku: currentOffer.retailerSku,
        observedAt: now,
        productAlertClassification,
      }),
      ...availabilityEvidence,
    ],
  };
}
