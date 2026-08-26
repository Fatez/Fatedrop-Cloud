import { canonicalKey, normalizeWhitespace, productTypeFromTitle, stableId } from "./normalize.mjs";

const DISCOVERY_MAX_ALERT_AGE_SECONDS = 30 * 60;
const DISCOVERY_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const RESERVED_EVIDENCE_KINDS = new Set([
  "official_retailer_product_page",
  "add_to_cart_verified",
  "checkout_verified",
  "availability_verified",
  "verified_stock_api",
  "purchase_path_verified",
]);

const HIGH_PRIORITY_PATTERNS = [
  [/30th|anniversary/i, "anniversary"],
  [/elite trainer|\betb\b/i, "elite_trainer_box"],
  [/booster\s+(?:display\s+)?box/i, "booster_box"],
  [/booster\s+bundle/i, "booster_bundle"],
  [/ultra\s+premium/i, "ultra_premium_collection"],
  [/premium\s+collection|collection\s+box/i, "major_collection"],
  [/pokemon\s+center\s+exclusive|pokémon\s+center\s+exclusive/i, "pokemon_center_exclusive"],
];

function clamp01(value, fallback = 0.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function observedEpoch(value, fallback) {
  if (Number.isFinite(value)) {
    const numeric = Number(value);
    return Math.trunc(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
  }
  return fallback;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$|ref$|source$|_pos$|_sid$|_ss$)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname === "/-" || /\/-\/?$/.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function matchesPattern(pattern, value) {
  if (!(pattern instanceof RegExp)) return true;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function retailerProductUrl(retailer, value) {
  const canonical = safeHttpUrl(value);
  if (!canonical) return null;
  try {
    const parsed = new URL(canonical);
    const base = new URL(retailer?.baseUrl || canonical);
    if (parsed.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
    if (!matchesPattern(retailer?.productUrlPattern, canonical)) return null;
    return canonical;
  } catch {
    return null;
  }
}

function skuFromUrl(retailer, url) {
  if (!url || !(retailer?.skuPattern instanceof RegExp)) return null;
  retailer.skuPattern.lastIndex = 0;
  const match = retailer.skuPattern.exec(url);
  return normalizeWhitespace(match?.[1]) || null;
}

function priorityFor(title) {
  for (const [pattern, reason] of HIGH_PRIORITY_PATTERNS) {
    if (pattern.test(title)) return { priority: "high", reason };
  }
  return { priority: "normal", reason: "standard_sealed_product" };
}

function sanitizedCollectorEvidence(evidence = [], observedAt) {
  if (!Array.isArray(evidence)) return [];
  return evidence
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => !RESERVED_EVIDENCE_KINDS.has(String(entry.kind || "").trim()))
    .slice(0, 30)
    .map((entry) => ({
      kind: "collector_evidence",
      value: JSON.stringify({ kind: entry.kind || null, value: entry.value ?? null }).slice(0, 1000),
      observedAt,
    }));
}

function purchaseEvidence(raw, observedAt) {
  const evidence = [];
  if (raw.addToCartEnabled === true) evidence.push({ kind: "add_to_cart_verified", value: "enabled_purchase_control", observedAt });
  if (raw.preorderPurchaseEnabled === true) evidence.push({ kind: "purchase_path_verified", value: "enabled_preorder_purchase_control", observedAt });
  if (raw.checkoutVerified === true) evidence.push({ kind: "checkout_verified", value: "checkout_or_basket_validation_succeeded", observedAt });
  if (raw.availabilityApiVerified === true) evidence.push({ kind: "verified_stock_api", value: "retailer_availability_api_positive", observedAt });
  if (raw.orderable === true) evidence.push({ kind: "purchase_path_verified", value: "orderability_verified", observedAt });
  return evidence;
}

function discoveryStockStatus(raw, { purchaseVerified, preorder, pageExists }) {
  const claimed = String(raw.stockStatus || "").trim().toLowerCase();
  if (purchaseVerified) {
    if (preorder) return "preorder";
    if (claimed === "low_stock") return "low_stock";
    return "in_stock";
  }
  if (pageExists === false) return "out_of_stock";
  if (preorder) return "preorder";
  if (["out_of_stock", "coming_soon"].includes(claimed)) return claimed;
  if (pageExists === true) return "coming_soon";
  return "unknown";
}

export function isDiscoveryObservationBatch(products) {
  return Array.isArray(products)
    && products.length > 0
    && products.every((item) => item?.discoveryObservation === true || item?.observationType === "product_discovery");
}

export function discoveryBatchObservedAt(products, fallback = Math.floor(Date.now() / 1000)) {
  const values = (products || [])
    .map((item) => observedEpoch(item?.discoveredAt ?? item?.observedAt, NaN))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : fallback;
}

export function normalizeDiscoveryProduct(raw, retailer, now = Math.floor(Date.now() / 1000)) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid product discovery observation");
  const title = normalizeWhitespace(raw.title);
  if (!title) throw new Error("Product discovery observations require a title");

  const observedAt = observedEpoch(raw.discoveredAt ?? raw.observedAt, now);
  const canonicalUrl = retailerProductUrl(retailer, raw.canonicalUrl || raw.url || raw.productUrl);
  const urlValid = Boolean(canonicalUrl);
  const pageExists = raw.pageExists === true ? true : raw.pageExists === false ? false : null;
  const officialPageVerified = raw.officialPageVerified === true && urlValid && pageExists !== false;
  const preorder = raw.preorder === true || raw.preorderText === true || raw.preorderLabel === true || /pre[ -]?order/i.test(String(raw.availabilityText || ""));
  const verifiedPurchaseEvidence = purchaseEvidence(raw, observedAt);
  const purchaseVerified = verifiedPurchaseEvidence.length > 0;
  const stockStatus = discoveryStockStatus(raw, { purchaseVerified, preorder, pageExists });
  const productType = raw.productType || productTypeFromTitle(title);
  const retailerSku = normalizeWhitespace(raw.retailerSku || raw.sku)
    || skuFromUrl(retailer, canonicalUrl)
    || normalizeWhitespace(raw.canonicalProductId)
    || stableId("discovery-sku", retailer?.id || "retailer", title);
  const freshnessAge = now - observedAt;
  const discoveryFresh = freshnessAge >= -DISCOVERY_MAX_FUTURE_SKEW_SECONDS && freshnessAge <= DISCOVERY_MAX_ALERT_AGE_SECONDS;
  const priority = priorityFor(title);

  const evidence = [
    { kind: "discovery_source", value: normalizeWhitespace(raw.evidenceSource || raw.source || "retailer_discovery_feed") || "retailer_discovery_feed", observedAt },
    { kind: "discovery_change_type", value: normalizeWhitespace(raw.changeType || raw.rawChangeType || "product_observed") || "product_observed", observedAt },
    { kind: "discovery_page_exists", value: pageExists == null ? "unknown" : String(pageExists), observedAt },
    { kind: "discovery_url_status", value: urlValid ? "verified_retailer_product_url" : "invalid_or_missing", observedAt },
    { kind: "discovery_priority", value: priority.priority, observedAt },
    { kind: "discovery_priority_reason", value: priority.reason, observedAt },
    ...(officialPageVerified ? [{ kind: "official_retailer_product_page", value: canonicalUrl, observedAt }] : []),
    ...(preorder ? [{ kind: "preorder_metadata", value: normalizeWhitespace(raw.availabilityText || "preorder_label_present") || "preorder_label_present", observedAt }] : []),
    ...(raw.releaseDate ? [{ kind: "launch_date", value: String(raw.releaseDate), observedAt }] : []),
    ...(pageExists === true ? [{ kind: "product_page_exists", value: "verified", observedAt }] : []),
    ...(pageExists === false ? [{ kind: "product_page_missing", value: "verified_missing", observedAt }] : []),
    ...verifiedPurchaseEvidence,
    ...(raw.rawObservation != null ? [{ kind: "discovery_raw_observation", value: String(raw.rawObservation).slice(0, 1500), observedAt }] : []),
    ...sanitizedCollectorEvidence(raw.evidence, observedAt),
    ...(!discoveryFresh ? [{ kind: "historical_discovery_reconciled", value: "not_alert_eligible", observedAt }] : []),
  ];

  return {
    retailerSku,
    title,
    url: canonicalUrl || "",
    imageUrl: safeHttpUrl(raw.imageUrl) || null,
    pricePence: Number.isFinite(raw.pricePence) ? Math.round(raw.pricePence) : null,
    postagePence: Number.isFinite(raw.postagePence) && raw.postagePence >= 0 ? Math.round(raw.postagePence) : null,
    officialRrpPence: Number.isFinite(raw.officialRrpPence) ? Math.round(raw.officialRrpPence) : null,
    gtin: normalizeWhitespace(raw.gtin || raw.barcode) || null,
    productType,
    canonicalKey: raw.canonicalKey || canonicalKey(title, productType),
    stockStatus,
    stockConfidence: purchaseVerified ? Math.max(0.95, clamp01(raw.confidence, 0.98)) : clamp01(raw.confidence, officialPageVerified ? 0.9 : 0.6),
    stockQuantity: Number.isFinite(raw.stockQuantity) ? raw.stockQuantity : null,
    language: raw.language,
    region: raw.region,
    edition: raw.edition,
    packCount: raw.packCount,
    caseQuantity: raw.caseQuantity,
    unitKind: raw.unitKind,
    formatVariant: raw.formatVariant,
    presentation: raw.presentation,
    identifiers: raw.identifiers,
    observedAt,
    discoveryFresh,
    evidence,
  };
}
