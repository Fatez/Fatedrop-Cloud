import { isPurchasable } from "./model.mjs";
import { PriceQuality, classifyObservedPrice } from "./price-quality.mjs";

const VERIFIED_PURCHASE_EVIDENCE = new Set([
  "add_to_cart_verified",
  "checkout_verified",
  "availability_verified",
  "verified_stock_api",
  "purchase_path_verified",
]);

const PREPARATION_METADATA_EVIDENCE = new Set([
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
]);

function evidenceKinds(evidence = []) {
  return new Set((Array.isArray(evidence) ? evidence : []).map((entry) => String(entry?.kind || "").trim()).filter(Boolean));
}

function evidenceValue(evidence = [], kind) {
  const entry = (Array.isArray(evidence) ? evidence : []).find((item) => item?.kind === kind && item?.value != null);
  return entry?.value ?? null;
}

function hasStructuredCatalogueEvidence(kinds) {
  return [...kinds].some((kind) => /(?:shopify|woocommerce|structured|catalogue|product_page|retailer_sku)/i.test(kind));
}

function repeatedObservationThresholdCrossed(previousOffer, now, minimumSeconds) {
  if (!previousOffer) return false;
  const firstSeenAt = Number(previousOffer.firstSeenAt);
  const previousSeenAt = Number(previousOffer.lastSeenAt);
  if (!Number.isFinite(firstSeenAt) || firstSeenAt <= 0 || !Number.isFinite(previousSeenAt) || previousSeenAt <= 0) return false;
  const previousAge = Math.max(0, previousSeenAt - firstSeenAt);
  const currentAge = Math.max(0, Number(now) - firstSeenAt);
  return previousAge < minimumSeconds && currentAge >= minimumSeconds;
}

export function hasVerifiedPurchaseEvidence(evidence = []) {
  const kinds = evidenceKinds(evidence);
  return [...VERIFIED_PURCHASE_EVIDENCE].some((kind) => kinds.has(kind));
}

export function effectivePurchasable(offer) {
  if (!offer || !isPurchasable(offer.stockStatus)) return false;
  const price = classifyObservedPrice({ pricePence: offer.pricePence, retailerId: offer.retailerId, evidence: offer.evidence });
  if (price.priceQuality === PriceQuality.PLACEHOLDER || price.priceQuality === PriceQuality.INVALID) {
    return hasVerifiedPurchaseEvidence(offer.evidence);
  }
  return true;
}

export function classifyRetailerPreparation({ previousOffer = null, currentOffer, now = Math.floor(Date.now() / 1000), repeatedAfterSeconds = 60 } = {}) {
  const evidence = Array.isArray(currentOffer?.evidence) ? currentOffer.evidence : [];
  const kinds = evidenceKinds(evidence);
  const price = classifyObservedPrice({ pricePence: currentOffer?.pricePence, retailerId: currentOffer?.retailerId, evidence });
  const purchaseVerified = hasVerifiedPurchaseEvidence(evidence);
  const structuredCatalogue = hasStructuredCatalogueEvidence(kinds);
  const identityValid = Boolean(currentOffer?.retailerId && currentOffer?.retailerSku && currentOffer?.title && currentOffer?.url);
  const repeated = repeatedObservationThresholdCrossed(previousOffer, now, repeatedAfterSeconds)
    || kinds.has("observation_repeated");
  const clusterId = evidenceValue(evidence, "retailer_preparation_cluster");
  const clusterStrong = Boolean(clusterId);
  const metadataKinds = [...kinds].filter((kind) => PREPARATION_METADATA_EVIDENCE.has(kind));
  const notConfirmedPurchasable = !effectivePurchasable(currentOffer);

  let score = 0;
  if (identityValid) score += 1;
  if (structuredCatalogue) score += 1;
  if (price.priceQuality === PriceQuality.PLACEHOLDER) score += 2;
  if (repeated) score += 2;
  if (clusterStrong) score += 3;
  score += Math.min(3, metadataKinds.length);

  const corroborated = repeated || clusterStrong || metadataKinds.length >= 2;
  const echoEligible = notConfirmedPurchasable
    && !purchaseVerified
    && identityValid
    && structuredCatalogue
    && corroborated
    && score >= 5;

  const lifecycleConfidence = echoEligible ? Math.min(0.98, 0.72 + (score * 0.04)) : Math.min(0.75, 0.25 + (score * 0.06));

  return {
    echoEligible,
    score,
    lifecycleConfidence,
    observationConfidence: Number.isFinite(currentOffer?.stockConfidence) ? currentOffer.stockConfidence : 0.5,
    identityConfidence: identityValid ? 0.98 : 0.25,
    availabilityConfidence: purchaseVerified ? 0.99 : effectivePurchasable(currentOffer) ? 0.8 : 0.15,
    price,
    evidence: [
      { kind: "retailer_preparation_score", value: String(score), observedAt: now },
      { kind: "retailer_preparation_identity", value: identityValid ? "valid" : "incomplete", observedAt: now },
      { kind: "retailer_preparation_structured_catalogue", value: structuredCatalogue ? "present" : "absent", observedAt: now },
      ...(repeated ? [{ kind: "retailer_preparation_repeated", value: "confirmed_across_observations", observedAt: now }] : []),
      ...(clusterStrong ? [{ kind: "retailer_preparation_cluster", value: String(clusterId), observedAt: now }] : []),
      ...metadataKinds.map((kind) => ({ kind: "retailer_preparation_metadata", value: kind, observedAt: now })),
    ],
  };
}
