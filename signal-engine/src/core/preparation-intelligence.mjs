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

function evidenceEntry(evidence = [], kind) {
  return (Array.isArray(evidence) ? evidence : []).find((item) => item?.kind === kind && item?.value != null) ?? null;
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
  if (!offer) return false;
  const kinds = evidenceKinds(offer.evidence);
  const purchaseVerified = [...VERIFIED_PURCHASE_EVIDENCE].some((kind) => kinds.has(kind));
  const purchaseVerificationRequired = kinds.has("purchase_verification_required");

  // PREORDER is a commercial lifecycle state only when a real purchase path is
  // independently verified. Retailer copy such as "Preorder" or a future
  // release date remains preparation evidence and can never Manifest by itself.
  if (offer.stockStatus === "preorder") return purchaseVerified;
  if (!isPurchasable(offer.stockStatus)) return false;
  if (purchaseVerificationRequired && !purchaseVerified) return false;

  const price = classifyObservedPrice({ pricePence: offer.pricePence, retailerId: offer.retailerId, evidence: offer.evidence });
  if (price.priceQuality === PriceQuality.PLACEHOLDER || price.priceQuality === PriceQuality.INVALID) {
    return purchaseVerified;
  }
  return true;
}

export function classifyRetailerPreparation({ previousOffer = null, currentOffer, now = Math.floor(Date.now() / 1000), repeatedAfterSeconds = 60 } = {}) {
  const evidence = Array.isArray(currentOffer?.evidence) ? currentOffer.evidence : [];
  const kinds = evidenceKinds(evidence);
  const previousKinds = evidenceKinds(previousOffer?.evidence);
  const price = classifyObservedPrice({ pricePence: currentOffer?.pricePence, retailerId: currentOffer?.retailerId, evidence });
  const previousPrice = classifyObservedPrice({ pricePence: previousOffer?.pricePence, retailerId: previousOffer?.retailerId, evidence: previousOffer?.evidence });
  const purchaseVerified = hasVerifiedPurchaseEvidence(evidence);

  // Preserve the established official-product-page behaviour for retailers that
  // already emit it. Smyths catalogue evidence is intentionally edge-triggered:
  // a newly staged catalogue listing can Echo once, then unchanged scans stay quiet.
  const officialProductPageVerified = kinds.has("official_retailer_product_page");
  const officialCatalogueVerified = kinds.has("official_retailer_catalogue_listing");
  const officialCataloguePreviouslyVerified = previousKinds.has("official_retailer_catalogue_listing");
  const officialCatalogueNew = officialCatalogueVerified && !officialCataloguePreviouslyVerified;
  const officialListingVerified = officialProductPageVerified || officialCatalogueNew;

  const structuredCatalogue = hasStructuredCatalogueEvidence(kinds);
  const identityValid = Boolean(currentOffer?.retailerId && currentOffer?.retailerSku && currentOffer?.title && currentOffer?.url);
  const repeated = repeatedObservationThresholdCrossed(previousOffer, now, repeatedAfterSeconds)
    || kinds.has("observation_repeated");
  const placeholderResolved = Boolean(previousOffer)
    && previousPrice.priceQuality === PriceQuality.PLACEHOLDER
    && price.priceQuality === PriceQuality.VALID;
  const cluster = evidenceEntry(evidence, "retailer_preparation_cluster");
  const clusterId = cluster?.value ?? null;
  const clusterMember = Boolean(clusterId);
  const clusterLeader = clusterMember && (cluster?.clusterLeader === true || cluster?.leaderOfferId === currentOffer?.offerId);
  const clusterStrong = clusterLeader;
  const suppressStandaloneLifecycle = clusterMember && !clusterLeader;
  const metadataKinds = [...kinds].filter((kind) => PREPARATION_METADATA_EVIDENCE.has(kind));
  const notConfirmedPurchasable = !effectivePurchasable(currentOffer);

  let score = 0;
  if (identityValid) score += 1;
  if (structuredCatalogue) score += 1;
  if (officialListingVerified) score += 3;
  if (price.priceQuality === PriceQuality.PLACEHOLDER) score += 2;
  if (repeated) score += 2;
  if (placeholderResolved) score += 3;
  if (clusterStrong) score += 3;
  score += Math.min(3, metadataKinds.length);

  const corroborated = officialListingVerified || repeated || placeholderResolved || clusterStrong || metadataKinds.length >= 2;
  const echoEligible = !suppressStandaloneLifecycle
    && notConfirmedPurchasable
    && !purchaseVerified
    && identityValid
    && structuredCatalogue
    && corroborated
    && score >= 5;

  const lifecycleConfidence = echoEligible ? Math.min(0.98, 0.72 + (score * 0.04)) : Math.min(0.75, 0.25 + (score * 0.06));

  return {
    echoEligible,
    suppressStandaloneLifecycle,
    clusterMember,
    clusterLeader,
    clusterId: clusterId == null ? null : String(clusterId),
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
      ...(officialListingVerified ? [{ kind: "retailer_preparation_official_listing", value: "verified_official_product_page", observedAt: now }] : []),
      ...(repeated ? [{ kind: "retailer_preparation_repeated", value: "confirmed_across_observations", observedAt: now }] : []),
      ...(placeholderResolved ? [{ kind: "retailer_preparation_price_transition", value: "placeholder_to_commercial", observedAt: now }] : []),
      ...(clusterStrong ? [{ kind: "retailer_preparation_cluster_leader", value: String(clusterId), observedAt: now }] : []),
      ...(suppressStandaloneLifecycle ? [{ kind: "retailer_preparation_cluster_member", value: String(clusterId), observedAt: now }] : []),
      ...metadataKinds.map((kind) => ({ kind: "retailer_preparation_metadata", value: kind, observedAt: now })),
    ],
  };
}
