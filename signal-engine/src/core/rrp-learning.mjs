import { createHash } from "node:crypto";
import { rrpObservationFingerprint } from "./rrp-gap-intelligence.mjs";

function normalizePart(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeSealedRrpCandidate(title = "") {
  const text = normalizePart(title);
  if (!text) return false;
  return /\b(?:3 pack blister|triple blister|3 pack booster|checklane blister|premium checklane blister|build and battle(?: box| kit| stadium)|elite trainer box|etb|booster pack|booster bundle|booster box|sleeved booster|collection box|premium collection|mini tin|tin)\b/.test(text);
}

export function rrpAliasSignature({ tcg = "pokemon", title, productType = "" } = {}) {
  return [normalizePart(tcg) || "pokemon", normalizePart(productType), normalizePart(title)].join("|");
}

export function rrpLearningId(prefix, signature) {
  return `${prefix}_${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

export function shouldQueueUnresolvedRrp({ title, productType, tcg = "pokemon", language = null, region = null } = {}) {
  const text = normalizePart(title);
  const type = normalizePart(productType);
  if (!text || normalizePart(tcg) !== "pokemon") return false;
  if (["accessory", "single", "graded"].includes(type)) return false;

  // Legacy retailer normalisation still labels some genuine sealed products as
  // `other` (notably 3-pack promo blisters). Do not throw those observations
  // away before the RRP learner sees them. The exception is deliberately narrow:
  // an `other` product only enters the queue when its title itself proves a known
  // sealed TCG product shape. Random bundles/merchandise remain excluded.
  if (type === "other" && !looksLikeSealedRrpCandidate(title)) return false;

  const importMarkers = /\b(japanese|japan|simplified chinese|traditional chinese|chinese|korean|korea)\b/i;
  if (importMarkers.test(String(title || ""))) return false;
  if (language && !/^en(?:[-_]|$)/i.test(String(language))) return false;
  if (region && !/^(gb|uk|united kingdom)$/i.test(String(region))) return false;
  return true;
}

export function unresolvedRrpRecord({ product, offer, retailer, failureReason = "no_verified_rrp_reference", observedAt } = {}) {
  const title = offer?.title || product?.title || "";
  const productType = offer?.productType || product?.productType || null;
  const tcg = product?.tcg || offer?.tcg || "pokemon";
  const signature = rrpAliasSignature({ tcg, title, productType });
  const stockStatus = offer?.stockStatus || null;
  const evidence = {
    alias_signature: signature,
    retailer_sku: offer?.retailerSku || null,
    gtin: offer?.gtin || null,
    canonical_key: product?.canonicalKey || null,
    stock_status: stockStatus,
    live_offer: ["in_stock", "low_stock", "preorder"].includes(String(stockStatus || "").toLowerCase()),
    price_pence: Number.isFinite(offer?.pricePence) ? Math.round(offer.pricePence) : null,
    postage_pence: Number.isFinite(offer?.postagePence) ? Math.round(offer.postagePence) : null,
    last_observation_at: observedAt || null,
  };
  evidence.current_observation_fingerprint = rrpObservationFingerprint({
    productId: product?.id || offer?.productId || null,
    offerId: offer?.offerId || null,
    failureReason,
    evidence,
  });
  return {
    id: rrpLearningId("rrpq", `${retailer?.id || offer?.retailerId || "unknown"}|${signature}`),
    tcg,
    productId: product?.id || offer?.productId || null,
    offerId: offer?.offerId || null,
    retailerId: retailer?.id || offer?.retailerId || "unknown",
    observedTitle: title,
    productType,
    languageCode: offer?.language || product?.language || null,
    regionCode: offer?.region || product?.region || null,
    failureReason,
    observedAt,
    evidence,
  };
}
