import { SignalState, StockStatus } from "./model.mjs";
import { markupPercent, stableId } from "./normalize.mjs";
import { classifyRetailerPreparation, effectivePurchasable } from "./preparation-intelligence.mjs";
import { PriceQuality } from "./price-quality.mjs";
import { classifyProductAlert } from "./product-alert-intelligence.mjs";
import { signalCapabilities } from "./signal-policy.mjs";
import { resolveSignalReference } from "./signal-reference.mjs";

function signalEvidence(evidence, { kind, state, alertClass, retailerSku, observedAt, priorLiveConfirmation = null, preparation = null, productAlert = null }) {
  const price = preparation?.price ?? null;
  return [
    ...(Array.isArray(evidence) ? evidence : []),
    ...(price ? [
      { kind: "raw_observed_price_pence", value: price.rawObservedPricePence == null ? "unknown" : String(price.rawObservedPricePence), observedAt },
      { kind: "price_quality", value: price.priceQuality, observedAt },
      { kind: "price_confidence", value: String(price.priceConfidence), observedAt },
    ] : []),
    ...(preparation ? [
      { kind: "observation_confidence", value: String(preparation.observationConfidence), observedAt },
      { kind: "identity_confidence", value: String(preparation.identityConfidence), observedAt },
      { kind: "availability_confidence", value: String(preparation.availabilityConfidence), observedAt },
      { kind: "lifecycle_confidence", value: String(preparation.lifecycleConfidence), observedAt },
      ...preparation.evidence,
    ] : []),
    ...(productAlert ? [
      { kind: "product_alert_category", value: productAlert.category, observedAt },
      { kind: "product_alert_subcategory", value: productAlert.subcategory, observedAt },
      { kind: "product_alert_confidence", value: String(productAlert.confidence), observedAt },
      ...productAlert.evidence.map((value) => ({ kind: "product_alert_evidence", value, observedAt })),
    ] : []),
    { kind: "signal_kind", value: kind, lifecycle: state, observedAt },
    { kind: "signal_alert_class", value: alertClass, observedAt },
    ...(retailerSku ? [{ kind: "retailer_sku", value: retailerSku, observedAt }] : []),
    ...(priorLiveConfirmation ? [{
      kind: "prior_live_confirmation",
      value: "persisted_purchasable_offer",
      observedAt: priorLiveConfirmation.observedAt,
      firstAvailableAt: priorLiveConfirmation.firstAvailableAt,
      stockStatus: priorLiveConfirmation.stockStatus,
      confidence: priorLiveConfirmation.confidence,
    }] : []),
  ];
}

function priorLiveConfirmation(previousOffer) {
  if (!previousOffer || !effectivePurchasable(previousOffer)) return null;
  const observedAt = Number(previousOffer.lastSeenAt);
  const firstAvailableAt = Number(previousOffer.everAvailableAt);
  if (!Number.isFinite(observedAt) || observedAt <= 0 || !Number.isFinite(firstAvailableAt) || firstAvailableAt <= 0) return null;
  return {
    observedAt,
    firstAvailableAt,
    stockStatus: previousOffer.stockStatus,
    confidence: Number.isFinite(previousOffer.stockConfidence) ? previousOffer.stockConfidence : null,
  };
}

export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  if (isBaseline) return null;

  const productAlert = classifyProductAlert({ title: currentOffer.title, productType: currentOffer.productType });
  // Beta alert delivery is intentionally sealed-TCG only. The offer/catalogue observation
  // is still persisted by the engine; we simply do not promote accessories, merchandise,
  // single cards or ambiguous products into the user-facing lifecycle stream.
  if (productAlert.category !== "SEALED_TCG") return null;

  const previousStatus = previousOffer?.stockStatus ?? null;
  const currentStatus = currentOffer.stockStatus;
  const wasPurchasable = previousOffer ? effectivePurchasable(previousOffer) : false;
  const nowPurchasable = effectivePurchasable(currentOffer);
  const policy = signalCapabilities(currentOffer.retailerId);
  const preparation = classifyRetailerPreparation({ previousOffer, currentOffer, now });

  let state = null;
  let kind = null;
  let reason = null;
  let priorLive = null;

  // FINAL FATEDROP LIFECYCLE CONTRACT:
  // WHISPER = earliest credible SKU/catalogue movement or weak pre-live state change.
  // ECHO = corroborated retailer preparation/readiness evidence before purchase availability is confirmed.
  // MANIFESTED = verified genuinely purchasable availability/restock.
  // VANISHED = previously confirmed purchasable availability lost.
  // Echo is universal: catalogue preparation and network/queue/security readiness can all contribute.
  // A placeholder price is evidence, never proof of purchasability and never commercial pricing truth.
  // Cluster members remain raw observations; one representative offer carries the lifecycle Echo.
  if (!wasPurchasable && !nowPurchasable && preparation.suppressStandaloneLifecycle) return null;

  if (!previousOffer) {
    if (nowPurchasable) {
      state = SignalState.MANIFESTED;
      kind = "new_listing_live";
      reason = "New retailer SKU discovered and verified purchasable";
    } else if (preparation.echoEligible) {
      state = SignalState.ECHO;
      kind = "retailer_preparation";
      reason = "Corroborated retailer preparation detected before verified purchase availability";
    } else if ([StockStatus.PREORDER, StockStatus.COMING_SOON, StockStatus.OUT_OF_STOCK].includes(currentStatus) || preparation.price.priceQuality === PriceQuality.PLACEHOLDER) {
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
    priorLive = priorLiveConfirmation(previousOffer);
    if (!priorLive) return null;
    state = SignalState.VANISHED;
    kind = "sold_out";
    reason = "Previously confirmed purchasable retailer SKU is no longer verified available";
  } else if (!nowPurchasable && preparation.echoEligible) {
    state = SignalState.ECHO;
    kind = "retailer_preparation";
    reason = "Corroborated retailer preparation detected before verified purchase availability";
  } else if (previousStatus !== currentStatus && !nowPurchasable) {
    state = SignalState.WHISPER;
    kind = "catalogue_state_change";
    reason = "Retailer SKU/catalogue state changed before verified availability";
  }

  if (!state || !kind) return null;
  const id = stableId("sig", currentOffer.offerId, state, kind, String(now), currentStatus);
  const commercialPricePence = preparation.price.canonicalPricePence;
  const reference = resolveSignalReference(currentOffer, now);
  const rrpPence = reference.rrpPence;
  const deliveredPricePence = currentOffer.postagePence == null || commercialPricePence == null
    ? null
    : commercialPricePence + currentOffer.postagePence;

  return {
    id,
    state,
    kind,
    alertClass: policy.alertClass,
    signalCapabilities: policy,
    productCategory: productAlert.category,
    productSubcategory: productAlert.subcategory,
    productCategoryConfidence: productAlert.confidence,
    productId: currentOffer.productId,
    offerId: currentOffer.offerId,
    retailerId: currentOffer.retailerId,
    retailerName: currentOffer.retailerName,
    retailerSku: currentOffer.retailerSku ?? null,
    title: currentOffer.title,
    productType: currentOffer.productType,
    url: currentOffer.url,
    imageUrl: currentOffer.imageUrl ?? null,
    rawObservedPricePence: preparation.price.rawObservedPricePence,
    priceQuality: preparation.price.priceQuality,
    priceConfidence: preparation.price.priceConfidence,
    pricePence: commercialPricePence,
    rrpPence,
    postagePence: currentOffer.postagePence ?? null,
    deliveredPricePence,
    markupPercent: markupPercent(commercialPricePence, rrpPence),
    stockStatus: currentStatus,
    previousStockStatus: previousStatus,
    confidence: state === SignalState.ECHO ? preparation.lifecycleConfidence : (currentOffer.stockConfidence ?? 0.5),
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
    evidence: signalEvidence([
      ...(Array.isArray(currentOffer.evidence) ? currentOffer.evidence : []),
      ...reference.evidence,
    ], {
      kind,
      state,
      alertClass: policy.alertClass,
      retailerSku: currentOffer.retailerSku,
      observedAt: now,
      priorLiveConfirmation: priorLive,
      preparation,
      productAlert,
    }),
  };
}
