import { SignalState, StockStatus } from "./model.mjs";
import { markupPercent, stableId } from "./normalize.mjs";
import { classifyRetailerPreparation, verifiedPurchasable } from "./preparation-intelligence.mjs";
import { PriceQuality } from "./price-quality.mjs";
import { classifyProductAlert } from "./product-alert-intelligence.mjs";
import { signalCapabilities } from "./signal-policy.mjs";
import { resolveSignalReference } from "./signal-reference.mjs";

const WHISPER_SCOUTING_EVIDENCE = new Set([
  "official_retailer_product_page",
  "official_retailer_catalogue_listing",
  "stock_object_present",
  "inventory_metadata",
  "launch_metadata",
  "launch_date",
  "preorder_metadata",
  "future_release_known",
  "retailer_backend_exposed",
  "network_readiness",
  "queue_readiness",
  "security_readiness",
  "add_to_cart_verified",
  "checkout_verified",
  "availability_verified",
  "verified_stock_api",
  "purchase_path_verified",
]);

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

function evidenceKinds(offer) {
  return new Set((Array.isArray(offer?.evidence) ? offer.evidence : [])
    .map((entry) => String(entry?.kind || "").trim())
    .filter(Boolean));
}

function identityComplete(offer) {
  return Boolean(offer?.retailerId && offer?.retailerSku && offer?.title && offer?.url);
}

function hasStructuredScoutingSurface(kinds) {
  return [...kinds].some((kind) => /(?:shopify|woocommerce|structured|catalogue|product_page|retailer_sku)/i.test(kind));
}

function credibleNewWhisperDiscovery(currentOffer) {
  const kinds = evidenceKinds(currentOffer);
  return identityComplete(currentOffer) && hasStructuredScoutingSurface(kinds);
}

function credibleWhisperEvidenceChange(previousOffer, currentOffer) {
  if (!previousOffer || !identityComplete(currentOffer)) return false;
  const previousKinds = evidenceKinds(previousOffer);
  const currentKinds = evidenceKinds(currentOffer);
  if (!hasStructuredScoutingSurface(currentKinds)) return false;
  return [...WHISPER_SCOUTING_EVIDENCE].some((kind) => previousKinds.has(kind) !== currentKinds.has(kind));
}

function quantityChanged(previousOffer, currentOffer) {
  if (!previousOffer) return false;
  const previousQuantity = Number.isFinite(previousOffer.stockQuantity) ? previousOffer.stockQuantity : null;
  const currentQuantity = Number.isFinite(currentOffer.stockQuantity) ? currentOffer.stockQuantity : null;
  return previousQuantity !== currentQuantity && (previousQuantity != null || currentQuantity != null);
}

function priorLiveConfirmation(previousOffer) {
  if (!previousOffer || !verifiedPurchasable(previousOffer)) return null;
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

function whisperDescriptor({ previousOffer, currentOffer, preparation }) {
  if (!identityComplete(currentOffer)) return null;
  const previousStatus = previousOffer?.stockStatus ?? null;
  const currentStatus = currentOffer.stockStatus;

  if (!previousOffer) {
    if ([StockStatus.PREORDER, StockStatus.COMING_SOON, StockStatus.OUT_OF_STOCK].includes(currentStatus)
      || preparation.price.priceQuality === PriceQuality.PLACEHOLDER
      || credibleNewWhisperDiscovery(currentOffer)) {
      return {
        state: SignalState.WHISPER,
        kind: "catalogue_new",
        reason: "New exact retailer SKU/catalogue activity observed; availability is reported but not confirmed by Whisper",
      };
    }
    return null;
  }

  if (previousStatus !== currentStatus) {
    return {
      state: SignalState.WHISPER,
      kind: "catalogue_state_change",
      reason: "Retailer SKU/catalogue stock state changed; Whisper reports the observed state without claiming purchase confirmation",
    };
  }

  if (quantityChanged(previousOffer, currentOffer)) {
    return {
      state: SignalState.WHISPER,
      kind: "inventory_quantity_change",
      reason: "Retailer inventory quantity changed; Whisper reports the observed movement without claiming purchase confirmation",
    };
  }

  if (credibleWhisperEvidenceChange(previousOffer, currentOffer)) {
    return {
      state: SignalState.WHISPER,
      kind: "preparation_evidence_change",
      reason: "Meaningful retailer stock/preparation evidence changed; availability is not confirmed by Whisper",
    };
  }

  return null;
}

function lifecycleDescriptor({ previousOffer, currentOffer, preparation }) {
  const wasPurchasable = previousOffer ? verifiedPurchasable(previousOffer) : false;
  const nowPurchasable = verifiedPurchasable(currentOffer);

  if (!previousOffer) {
    if (nowPurchasable) {
      return {
        state: SignalState.MANIFESTED,
        kind: "new_listing_live",
        reason: "New retailer SKU discovered with verified purchase availability",
      };
    }
    if (preparation.echoEligible) {
      return {
        state: SignalState.ECHO,
        kind: "retailer_preparation",
        reason: "Corroborated retailer preparation detected before verified purchase availability",
      };
    }
    return null;
  }

  if (!wasPurchasable && nowPurchasable) {
    if (previousOffer?.everAvailableAt) {
      return {
        state: SignalState.MANIFESTED,
        kind: "restock",
        reason: "Previously available retailer SKU returned to verified purchase availability",
      };
    }
    return {
      state: SignalState.MANIFESTED,
      kind: "availability_live",
      reason: "Retailer SKU purchase availability became verified",
    };
  }

  if (wasPurchasable && !nowPurchasable) {
    const priorLive = priorLiveConfirmation(previousOffer);
    if (!priorLive) return null;
    return {
      state: SignalState.VANISHED,
      kind: "sold_out",
      reason: "Previously confirmed purchasable retailer SKU is no longer verified available",
      priorLive,
    };
  }

  if (!nowPurchasable && preparation.echoEligible) {
    return {
      state: SignalState.ECHO,
      kind: "retailer_preparation",
      reason: "Corroborated retailer preparation detected before verified purchase availability",
    };
  }

  return null;
}

function buildSignal({ descriptor, currentOffer, previousOffer, preparation, productAlert, policy, now }) {
  if (!descriptor) return null;
  const { state, kind, reason, priorLive = null } = descriptor;
  const currentStatus = currentOffer.stockStatus;
  const previousStatus = previousOffer?.stockStatus ?? null;
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

export function deriveSignals({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  if (isBaseline) return [];

  const productAlert = classifyProductAlert({ title: currentOffer.title, productType: currentOffer.productType });
  // Beta alert delivery is intentionally sealed-TCG only. The offer/catalogue observation
  // is still persisted by the engine; accessories, merchandise, single cards and ambiguous
  // products do not enter the user-facing lifecycle stream.
  if (productAlert.category !== "SEALED_TCG") return [];

  const policy = signalCapabilities(currentOffer.retailerId);
  const preparation = classifyRetailerPreparation({ previousOffer, currentOffer, now });
  const descriptors = [];

  // FINAL FATEDROP LIFECYCLE CONTRACT:
  // WHISPER = the monitoring heartbeat: a meaningful retailer SKU/stock/inventory/evidence change.
  //           It reports the retailer's observed status but never claims that purchase is confirmed.
  // ECHO = corroborated retailer preparation/readiness before purchase availability is confirmed.
  // MANIFESTED = independently verified genuinely purchasable availability/restock.
  // VANISHED = previously verified purchasable availability lost.
  // A stronger lifecycle conclusion never erases the Whisper observation that led to it.
  const whisper = whisperDescriptor({ previousOffer, currentOffer, preparation });
  if (whisper) descriptors.push(whisper);

  const lifecycle = lifecycleDescriptor({ previousOffer, currentOffer, preparation });
  if (lifecycle) descriptors.push(lifecycle);

  return descriptors
    .map((descriptor) => buildSignal({ descriptor, currentOffer, previousOffer, preparation, productAlert, policy, now }))
    .filter(Boolean);
}

// Compatibility helper for focused callers/tests that expect one strongest lifecycle result.
// The engine itself uses deriveSignals() so Whisper can coexist with Echo/Manifested/Vanished.
export function deriveSignal(args) {
  const signals = deriveSignals(args);
  return signals.find((signal) => signal.state !== SignalState.WHISPER) ?? signals[0] ?? null;
}
