import { classifyRrpApplicability } from "../core/rrp-applicability.mjs";
import { buildRrpValueContext, resolveRrpValue } from "../core/rrp-value-reference.mjs";
import { createLiveOfferReadStore } from "../stores/live-offer-read-store.mjs";

const PURCHASABLE = new Set(["in_stock", "low_stock", "preorder"]);
const KINDS = Object.freeze(["official", "component_reference", "pack_reference"]);

function percentage(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function productTypeFor(offer, linkedProduct) {
  return linkedProduct?.productType || offer?.productType || "unknown";
}

function blankType() {
  return {
    liveOffers: 0,
    resolvedOffers: 0,
    unresolvedOffers: 0,
    coveragePercent: 0,
    referenceEligibleOffers: 0,
    referenceExcludedOffers: 0,
    eligibleResolvedOffers: 0,
    eligibleUnresolvedOffers: 0,
    eligibleCoveragePercent: 0,
  };
}

export function buildEffectiveRrpCoverage({ offers = [], products = [] } = {}) {
  const liveOffers = (offers || []).filter((offer) => PURCHASABLE.has(offer?.stockStatus));
  const productsById = new Map((products || []).map((product) => [product.id, product]));
  const context = buildRrpValueContext(products || []);
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const byProductType = {};
  const excludedByReason = {};
  let resolvedOffers = 0;
  let directVerifiedLinkedOffers = 0;
  let referenceEligibleOffers = 0;
  let referenceExcludedOffers = 0;
  let eligibleResolvedOffers = 0;

  for (const offer of liveOffers) {
    const linkedProduct = productsById.get(offer.productId) || null;
    const productType = productTypeFor(offer, linkedProduct);
    const title = linkedProduct?.title || offer.title || "";
    const applicability = classifyRrpApplicability({ title, productType });
    const bucket = byProductType[productType] || blankType();
    bucket.liveOffers += 1;

    if (applicability.eligible) {
      referenceEligibleOffers += 1;
      bucket.referenceEligibleOffers += 1;
    } else {
      referenceExcludedOffers += 1;
      bucket.referenceExcludedOffers += 1;
      const reason = applicability.reason || "not_fairly_comparable";
      excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
    }

    if (Number.isFinite(linkedProduct?.officialRrpPence) && linkedProduct.officialRrpPence > 0 && linkedProduct?.rrpSource) {
      directVerifiedLinkedOffers += 1;
    }

    const rrp = resolveRrpValue({
      title,
      productType,
      tcg: linkedProduct?.tcg || "pokemon",
      linkedProduct,
    }, context);

    if (rrp?.resolved) {
      resolvedOffers += 1;
      bucket.resolvedOffers += 1;
      if (applicability.eligible) {
        eligibleResolvedOffers += 1;
        bucket.eligibleResolvedOffers += 1;
      }
      const kind = KINDS.includes(rrp.kind) ? rrp.kind : "official";
      byKind[kind] += 1;
    } else {
      bucket.unresolvedOffers += 1;
      if (applicability.eligible) bucket.eligibleUnresolvedOffers += 1;
    }
    byProductType[productType] = bucket;
  }

  for (const bucket of Object.values(byProductType)) {
    bucket.coveragePercent = percentage(bucket.resolvedOffers, bucket.liveOffers);
    bucket.eligibleCoveragePercent = percentage(bucket.eligibleResolvedOffers, bucket.referenceEligibleOffers);
  }

  return {
    liveOffers: liveOffers.length,
    resolvedOffers,
    unresolvedOffers: liveOffers.length - resolvedOffers,
    coveragePercent: percentage(resolvedOffers, liveOffers.length),
    referenceEligibleOffers,
    referenceExcludedOffers,
    eligibleResolvedOffers,
    eligibleUnresolvedOffers: Math.max(0, referenceEligibleOffers - eligibleResolvedOffers),
    eligibleCoveragePercent: percentage(eligibleResolvedOffers, referenceEligibleOffers),
    excludedByReason,
    directVerifiedLinkedOffers,
    resolverLiftOffers: Math.max(0, resolvedOffers - directVerifiedLinkedOffers),
    byKind,
    byProductType,
  };
}

export async function loadEffectiveRrpCoverage(store) {
  if (!store || typeof store.listOffers !== "function" || typeof store.listProducts !== "function" || typeof store.listRetailers !== "function") {
    return { available: false, reason: "catalogue_store_unavailable" };
  }
  try {
    const liveStore = createLiveOfferReadStore(store);
    const [offers, products] = await Promise.all([
      liveStore.listOffers({ limit: 10_000 }),
      liveStore.listProducts({ limit: 5_000 }),
    ]);
    return { available: true, evidenceScope: "fresh_healthy_retailers", ...buildEffectiveRrpCoverage({ offers, products }) };
  } catch {
    return { available: false, reason: "coverage_query_failed" };
  }
}
