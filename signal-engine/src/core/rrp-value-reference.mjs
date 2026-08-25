import { buildCanonicalRrpRegistry, resolveCanonicalRrp } from "./canonical-rrp-registry.mjs";
import { resolveInternationalMsrp } from "../rrp/international-msrp-authority.mjs";

function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[™®©]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function authoritative(product) {
  if (!product) return false;
  return Number.isFinite(product.officialRrpPence)
    && product.officialRrpPence > 0
    && typeof product.rrpSource === "string"
    && product.rrpSource.trim().length > 0;
}

function bundleQuantity(title = "") {
  const text = fold(title);
  if (/\b(?:booster box|booster display|half booster box|elite trainer box|etb|booster bundle|blister|checklane|collection|tin|deck)\b/.test(text)) return null;
  if (/\bopened live(?: on stream)?\b/.test(text)) return null;

  for (const pattern of [
    /\b(\d{1,3})\s+(?:booster\s+)?packs?\s+bundle\b/,
    /\b(?:booster\s+)?pack\s+bundle\s+(\d{1,3})\s+packs?\b/,
    /\b(?:booster\s+)?pack\s+bundle\s*\(?\s*(\d{1,3})\s+packs?\s*\)?\b/,
  ]) {
    const match = text.match(pattern);
    const quantity = match ? Number.parseInt(match[1], 10) : null;
    if (Number.isFinite(quantity) && quantity > 1 && quantity <= 100) return quantity;
  }
  return null;
}

function multiPackQuantity(title = "") {
  const text = fold(title);
  const match = text.match(/\b(\d{1,3})\s+(?:booster\s+)?packs?\b/);
  if (!match) return null;
  const quantity = Number.parseInt(match[1], 10);
  return Number.isFinite(quantity) && quantity > 1 ? quantity : null;
}

function packFormatVariant(title = "") {
  return /\bsleeved booster(?: pack)?\b/.test(fold(title)) ? "sleeved" : "standard";
}

function setTokens(title = "") {
  const text = fold(title)
    .replace(/\b(?:pokemon|tcg|trading card game|trading cards|cards)\b/g, " ")
    .replace(/\b(?:sleeved|sealed|standard|english|uk|united kingdom)\b/g, " ")
    .replace(/\b(?:booster|packs?|bundle|display|box|opened|live|stream)\b/g, " ")
    .replace(/\b\d{1,3}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...new Set(text.split(" ").filter((token) => token.length >= 3))];
}

function isVerifiedSingleBooster(product, expectedVariant = "standard") {
  if (!authoritative(product) || product.productType !== "booster_pack") return false;
  const text = fold(product.title);
  if (!/\bbooster pack\b/.test(text)) return false;
  if (/\b(?:bundle|blister|checklane|collection|promo|box|display)\b/.test(text)) return false;
  if (multiPackQuantity(product.title)) return false;
  if (packFormatVariant(product.title) !== expectedVariant) return false;
  return true;
}

function basePackReference(input, products = []) {
  const targetTokens = setTokens(input.title);
  const targetVariant = input.formatVariant || packFormatVariant(input.title);
  if (targetTokens.length < 2) return { resolved: false, reason: "reference_identity_too_weak" };

  const candidates = (products || []).filter((product) => {
    if (!isVerifiedSingleBooster(product, targetVariant)) return false;
    const candidateTokens = new Set(setTokens(product.title));
    return targetTokens.every((token) => candidateTokens.has(token));
  });
  if (!candidates.length) return { resolved: false, reason: "no_verified_pack_reference" };

  const prices = [...new Set(candidates.map((product) => Math.round(product.officialRrpPence)))];
  if (prices.length !== 1) {
    return { resolved: false, reason: "conflicting_verified_pack_reference", prices };
  }

  const sources = [...new Set(candidates.map((product) => String(product.rrpSource).trim()).filter(Boolean))];
  const observed = candidates
    .map((product) => Number(product.rrpObservedAt))
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    resolved: true,
    unitRrpPence: prices[0],
    rrpSource: sources.length === 1 ? sources[0] : `verified:${sources.sort().join("+")}`,
    rrpObservedAt: observed.length ? Math.max(...observed) : null,
    matchedProductIds: candidates.map((product) => product.id).filter(Boolean),
  };
}

function officialResult(product) {
  return {
    resolved: true,
    kind: "official",
    rrpPence: Math.round(product.officialRrpPence),
    rrpSource: String(product.rrpSource).trim(),
    rrpObservedAt: Number.isFinite(product.rrpObservedAt) ? product.rrpObservedAt : null,
    unitCount: 1,
    unitKind: product.productType || "product",
    unitRrpPence: Math.round(product.officialRrpPence),
    referenceBasis: "Verified official RRP for this product identity",
    matchedProductIds: product.id ? [product.id] : [],
  };
}

export function buildRrpValueContext(products = []) {
  return {
    products,
    registry: buildCanonicalRrpRegistry(products),
  };
}

export function resolveRrpValue(input = {}, context = {}) {
  const linkedProduct = input.linkedProduct || null;
  const products = context.products || [];
  const registry = context.registry || buildCanonicalRrpRegistry(products);
  const title = linkedProduct?.title || input.title || "";
  const productType = linkedProduct?.productType || input.productType;

  // Source-market products must never silently inherit an English/UK RRP.
  // If an import is recognised, either return its verified local MSRP reference
  // or fail closed with the source-market reason supplied by the authority layer.
  const international = resolveInternationalMsrp({
    title,
    productType,
    linkedProduct,
  });
  if (international.recognized) {
    // Native-currency MSRP is authoritative. For multi-unit imports the GBP total
    // is converted once from that native total. Do not also expose a penny-rounded
    // per-unit GBP value: multiplying rounded pennies can differ from direct FX by
    // a few pence and would (correctly) trip the global RRP consistency guard.
    if (international.resolved && Number(international.unitCount) > 1) {
      return { ...international, unitRrpPence: null };
    }
    return international;
  }

  if (authoritative(linkedProduct)) return officialResult(linkedProduct);

  const exact = resolveCanonicalRrp({
    title,
    productType,
    tcg: linkedProduct?.tcg || input.tcg || "pokemon",
    language: input.language,
    region: input.region,
    edition: input.edition,
  }, registry);
  if (exact.resolved) {
    return {
      resolved: true,
      kind: "official",
      rrpPence: exact.officialRrpPence,
      rrpSource: exact.rrpSource,
      rrpObservedAt: exact.rrpObservedAt,
      unitCount: 1,
      unitKind: productType || "product",
      unitRrpPence: exact.officialRrpPence,
      referenceBasis: "Verified official RRP matched to the canonical product identity",
      matchedProductIds: exact.matchedProductIds || [],
    };
  }

  const quantity = bundleQuantity(title);
  if (quantity) {
    const base = basePackReference({ title }, products);
    if (!base.resolved) return base;
    return {
      resolved: true,
      kind: "component_reference",
      rrpPence: base.unitRrpPence * quantity,
      rrpSource: `component:${base.rrpSource}`,
      rrpObservedAt: base.rrpObservedAt,
      unitCount: quantity,
      unitKind: "booster_pack",
      unitRrpPence: base.unitRrpPence,
      referenceBasis: `${quantity} × verified booster-pack RRP`,
      matchedProductIds: base.matchedProductIds,
    };
  }

  if (productType === "booster_pack" && !multiPackQuantity(title)) {
    const base = basePackReference({ title }, products);
    if (base.resolved) {
      return {
        resolved: true,
        kind: "pack_reference",
        rrpPence: base.unitRrpPence,
        rrpSource: `reference:${base.rrpSource}`,
        rrpObservedAt: base.rrpObservedAt,
        unitCount: 1,
        unitKind: "booster_pack",
        unitRrpPence: base.unitRrpPence,
        referenceBasis: "Verified booster-pack RRP reference for this set",
        matchedProductIds: base.matchedProductIds,
      };
    }
  }

  return { resolved: false, reason: exact.reason || "verified_rrp_unavailable" };
}
