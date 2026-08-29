import { SignalState, StockStatus } from "./model.mjs";
import { markupPercent, stableId } from "./normalize.mjs";
import { classifyRetailerPreparation, effectivePurchasable } from "./preparation-intelligence.mjs";
import { PriceQuality } from "./price-quality.mjs";
import { classifyProductAlert } from "./product-alert-intelligence.mjs";
import { signalCapabilities } from "./signal-policy.mjs";
import { resolveSignalReference } from "./signal-reference.mjs";

export const WHISPER_RECYCLE_SECONDS = 12 * 60 * 60;

// Oru is intentionally broad and lenient. These are product-side clues that can
// matter before FateDrop has enough evidence to claim verified availability.
// Retailer queue/security/access-control readiness is NOT in this set; that is
// Fenn/Echo territory and is emitted by network-readiness.mjs.
const WHISPER_PRODUCT_EVIDENCE = new Set([
  "official_retailer_product_page",
  "official_retailer_catalogue_listing",
  "product_page_exists",
  "product_page_missing",
  "stock_object_present",
  "inventory_metadata",
  "launch_metadata",
  "launch_date",
  "preorder_metadata",
  "future_release_known",
  "retailer_backend_exposed",
  "purchase_verification_required",
  "discovery_change_type",
  "discovery_page_exists",
  "discovery_url_status",
]);

const WHISPER_RECYCLABLE_STATUSES = new Set([
  StockStatus.IN_STOCK,
  StockStatus.LOW_STOCK,
  StockStatus.PREORDER,
  StockStatus.COMING_SOON,
  StockStatus.UNKNOWN,
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

function identitySufficient(offer) {
  return Boolean(offer?.retailerId && offer?.retailerSku && offer?.title);
}

function hasProductScoutingSurface(kinds) {
  return [...kinds].some((kind) => /(?:shopify|woocommerce|structured|catalogue|product_page|retailer_sku|discovery_)/i.test(kind));
}

function hasCredibleWhisperSurface(currentOffer) {
  if (!identitySufficient(currentOffer)) return false;
  const kinds = evidenceKinds(currentOffer);
  return hasProductScoutingSurface(kinds)
    || [...kinds].some((kind) => WHISPER_PRODUCT_EVIDENCE.has(kind));
}

function credibleNewWhisperDiscovery(currentOffer) {
  const kinds = evidenceKinds(currentOffer);
  return identitySufficient(currentOffer) && hasProductScoutingSurface(kinds);
}

function comparableEvidenceValue(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (entry.value != null) return String(entry.value);
  const clone = { ...entry };
  delete clone.observedAt;
  try { return JSON.stringify(clone); }
  catch { return String(entry.kind || ""); }
}

function evidenceFingerprint(offer, allowedKinds) {
  const values = [];
  for (const entry of Array.isArray(offer?.evidence) ? offer.evidence : []) {
    const kind = String(entry?.kind || "").trim();
    if (!allowedKinds.has(kind)) continue;
    values.push(`${kind}:${comparableEvidenceValue(entry)}`);
  }
  return values.sort().join("|");
}

function credibleWhisperEvidenceChange(previousOffer, currentOffer) {
  if (!previousOffer || !identitySufficient(currentOffer)) return false;
  const previousFingerprint = evidenceFingerprint(previousOffer, WHISPER_PRODUCT_EVIDENCE);
  const currentFingerprint = evidenceFingerprint(currentOffer, WHISPER_PRODUCT_EVIDENCE);
  if (!previousFingerprint && !currentFingerprint) return false;
  return previousFingerprint !== currentFingerprint;
}

function priceChanged(previousOffer, currentOffer) {
  if (!previousOffer) return false;
  const previousPrice = Number.isFinite(previousOffer.pricePence) ? previousOffer.pricePence : null;
  const currentPrice = Number.isFinite(currentOffer.pricePence) ? currentOffer.pricePence : null;
  return previousPrice !== currentPrice && (previousPrice != null || currentPrice != null);
}

function quantityChanged(previousOffer, currentOffer) {
  if (!previousOffer) return false;
  const previousQuantity = Number.isFinite(previousOffer.stockQuantity) ? previousOffer.stockQuantity : null;
  const currentQuantity = Number.isFinite(currentOffer.stockQuantity) ? currentOffer.stockQuantity : null;
  return previousQuantity !== currentQuantity && (previousQuantity != null || currentQuantity != null);
}

function whisperRecycleDue(previousOffer, currentOffer, now) {
  if (!previousOffer || !WHISPER_RECYCLABLE_STATUSES.has(currentOffer?.stockStatus)) return false;
  if (!hasCredibleWhisperSurface(currentOffer)) return false;
  const lastWhisperAt = Number(previousOffer.lastWhisperAt);
  if (!Number.isFinite(lastWhisperAt) || lastWhisperAt <= 0) return false;
  return Number(now) - lastWhisperAt >= WHISPER_RECYCLE_SECONDS;
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

function buildSignal({ state, kind, reason, currentOffer, previousOffer, preparation, productAlert, policy, now, priorLive = null }) {
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

export function deriveSignal({ previousOffer, currentOffer, isBaseline = false, now = Math.floor(Date.now() / 1000) }) {
  if (isBaseline) return null;

  const productAlert = classifyProductAlert({ title: currentOffer.title, productType: currentOffer.productType });
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

  // CANONICAL FATEDROP LIFECYCLE CONTRACT (restored from the original Aug-21 lock):
  // WHISPER / ORU = broad, lenient product-side early intelligence: new catalogue
  //   entries/pages, preorder/coming-soon hints, stock metadata, price/quantity/state
  //   movement and other meaningful product-side clues before confirmed live stock.
  //   If a credible unresolved stock/product condition remains active, Oru may
  //   re-alert after a 12-hour cooldown so useful stock-watch intelligence does
  //   not disappear indefinitely merely because the retailer state stayed stable.
  // ECHO / FENN = retailer readiness behaviour: queue, waiting-room, security,
  //   challenge/access-control and similar readiness states. Echo is emitted by
  //   network-readiness.mjs, not by ordinary catalogue classification here.
  // MANIFESTED / KORU = verified genuinely purchasable availability/restock.
  // VANISHED / NYXEN = previously verified purchasable availability lost.
  // Not every event must pass through every stage.
  if (!previousOffer) {
    if (nowPurchasable) {
      state = SignalState.MANIFESTED;
      kind = "new_listing_live";
      reason = "New retailer SKU discovered and verified purchasable";
    } else if ([StockStatus.PREORDER, StockStatus.COMING_SOON, StockStatus.OUT_OF_STOCK].includes(currentStatus)
      || preparation.price.priceQuality === PriceQuality.PLACEHOLDER
      || credibleNewWhisperDiscovery(currentOffer)) {
      state = SignalState.WHISPER;
      kind = "catalogue_new";
      reason = "Early product/catalogue intelligence observed before verified availability";
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
  } else if (!nowPurchasable && previousStatus !== currentStatus) {
    state = SignalState.WHISPER;
    kind = "catalogue_state_change";
    reason = "Product/catalogue availability state moved before verified live stock";
  } else if (!nowPurchasable && quantityChanged(previousOffer, currentOffer)) {
    state = SignalState.WHISPER;
    kind = "inventory_quantity_change";
    reason = "Product inventory metadata moved before verified live stock";
  } else if (!nowPurchasable && priceChanged(previousOffer, currentOffer)) {
    state = SignalState.WHISPER;
    kind = "catalogue_price_change";
    reason = "Product/catalogue price metadata moved before verified live stock";
  } else if (!nowPurchasable && credibleWhisperEvidenceChange(previousOffer, currentOffer)) {
    state = SignalState.WHISPER;
    kind = "product_evidence_change";
    reason = "Meaningful product-side evidence moved before verified live stock";
  } else if (!nowPurchasable && whisperRecycleDue(previousOffer, currentOffer, now)) {
    state = SignalState.WHISPER;
    kind = "stock_watch_refresh";
    reason = "Unresolved credible stock/product intelligence remains active after the 12-hour Oru cooldown";
  }

  if (!state || !kind) return null;
  return buildSignal({ state, kind, reason, currentOffer, previousOffer, preparation, productAlert, policy, now, priorLive });
}

// Compatibility for the engine's P0 branch wiring. Catalogue classification still
// emits at most one product lifecycle signal per offer observation; Echo remains a
// separate retailer-readiness event path.
export function deriveSignals(args) {
  const signal = deriveSignal(args);
  return signal ? [signal] : [];
}
