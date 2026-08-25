import { normalizeTitle, stableId } from "./normalize.mjs";
import { PriceQuality, classifyObservedPrice } from "./price-quality.mjs";

const CONFIGURATION_PATTERNS = [
  /\belite trainer box\b/g,
  /\bbooster display\b/g,
  /\bbooster box\b/g,
  /\bbooster bundle\b/g,
  /\bsleeved booster\b/g,
  /\bbooster pack\b/g,
  /\bpremium checklane blisters?\b/g,
  /\bchecklane blisters?\b/g,
  /\b\d+ pack blisters?\b/g,
  /\bblisters?\b/g,
  /\b\d+ packs?\b/g,
  /\bsealed case\b/g,
  /\bcase\b/g,
];

const LEADER_PRIORITY = Object.freeze({
  elite_trainer_box: 0,
  booster_box: 1,
  booster_bundle: 2,
  booster_pack: 3,
  collection_box: 4,
  other: 9,
});

function structuredCatalogueEvidence(evidence = []) {
  return (Array.isArray(evidence) ? evidence : []).some((entry) => /(?:shopify|woocommerce|structured|catalogue|product_page|retailer_sku)/i.test(String(entry?.kind || "")));
}

function thresholdCrossed(previousOffer, now, thresholdSeconds) {
  if (!previousOffer) return false;
  const firstSeenAt = Number(previousOffer.firstSeenAt);
  const previousSeenAt = Number(previousOffer.lastSeenAt);
  if (!Number.isFinite(firstSeenAt) || firstSeenAt <= 0 || !Number.isFinite(previousSeenAt) || previousSeenAt <= 0) return false;
  return previousSeenAt - firstSeenAt < thresholdSeconds && Number(now) - firstSeenAt >= thresholdSeconds;
}

function clusterLeader(members) {
  return [...members].sort((a, b) => {
    const aPriority = LEADER_PRIORITY[a.productType] ?? 8;
    const bPriority = LEADER_PRIORITY[b.productType] ?? 8;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return String(a.raw.title || a.offerId).localeCompare(String(b.raw.title || b.offerId));
  })[0] ?? null;
}

export function preparationFamilyKey(title = "") {
  let family = normalizeTitle(title);
  for (const pattern of CONFIGURATION_PATTERNS) family = family.replace(pattern, " ");
  family = family.replace(/\b(?:x\s*)?\d+\b/g, " ").replace(/\s+/g, " ").trim();
  const tokens = family.split(" ").filter(Boolean);
  return tokens.length >= 2 ? tokens.join(" ") : null;
}

export function buildRetailerPreparationClusters({ retailerId, prepared = [], previousOffers = new Map(), now = Math.floor(Date.now() / 1000), repeatedAfterSeconds = 60 } = {}) {
  const groups = new Map();

  for (const item of prepared) {
    const raw = item?.raw;
    if (!raw || !item?.offerId || !raw.retailerSku || !raw.url) continue;
    const familyKey = preparationFamilyKey(raw.title);
    if (!familyKey) continue;
    const price = classifyObservedPrice({ pricePence: raw.pricePence, retailerId, evidence: raw.evidence });
    const placeholder = price.priceQuality === PriceQuality.PLACEHOLDER;
    const notConfirmedPurchasable = !["in_stock", "low_stock", "preorder"].includes(raw.stockStatus) || placeholder;
    if (!notConfirmedPurchasable) continue;

    const member = {
      ...item,
      familyKey,
      placeholder,
      structured: structuredCatalogueEvidence(raw.evidence),
      productType: raw.productType || "other",
      previousOffer: previousOffers?.get?.(item.offerId) ?? null,
    };
    if (!groups.has(familyKey)) groups.set(familyKey, []);
    groups.get(familyKey).push(member);
  }

  const clusters = [];
  const byOfferId = new Map();
  for (const [familyKey, members] of groups) {
    const skuCount = new Set(members.map((member) => member.raw.retailerSku)).size;
    const productTypeCount = new Set(members.map((member) => member.productType)).size;
    const placeholderPriceCount = members.filter((member) => member.placeholder).length;
    const structuredEvidenceCount = members.filter((member) => member.structured).length;
    const newSkuCount = members.filter((member) => !member.previousOffer).length;
    const repeatedCrossingCount = members.filter((member) => thresholdCrossed(member.previousOffer, now, repeatedAfterSeconds)).length;

    const strong = skuCount >= 3
      && productTypeCount >= 2
      && placeholderPriceCount >= 2
      && structuredEvidenceCount >= 3;
    const activationMode = newSkuCount >= 3
      ? "new_family_activation"
      : repeatedCrossingCount >= 3
        ? "confirmed_family_activation"
        : null;
    if (!strong || !activationMode) continue;

    const leader = clusterLeader(members);
    const firstObservedAt = Math.min(...members.map((member) => Number(member.previousOffer?.firstSeenAt) || Number(now)));
    const cluster = {
      id: stableId("prep", retailerId || "unknown", familyKey, String(firstObservedAt)),
      retailerId: retailerId || null,
      productFamilyKey: familyKey,
      firstObservedAt,
      observedAt: now,
      leaderOfferId: leader?.offerId ?? null,
      skuCount,
      productTypeCount,
      placeholderPriceCount,
      structuredEvidenceCount,
      newSkuCount,
      repeatedCrossingCount,
      activationMode,
      confidence: Math.min(0.98, 0.8 + Math.min(0.18, (skuCount - 2) * 0.03)),
    };
    clusters.push(cluster);
    for (const member of members) byOfferId.set(member.offerId, cluster);
  }

  return { clusters, byOfferId };
}

export function preparationClusterEvidence(cluster, offerId = null) {
  if (!cluster) return [];
  return [{
    kind: "retailer_preparation_cluster",
    value: cluster.id,
    observedAt: cluster.observedAt,
    productFamilyKey: cluster.productFamilyKey,
    leaderOfferId: cluster.leaderOfferId,
    clusterLeader: Boolean(offerId && cluster.leaderOfferId === offerId),
    skuCount: cluster.skuCount,
    productTypeCount: cluster.productTypeCount,
    placeholderPriceCount: cluster.placeholderPriceCount,
    structuredEvidenceCount: cluster.structuredEvidenceCount,
    activationMode: cluster.activationMode,
    confidence: cluster.confidence,
  }];
}
