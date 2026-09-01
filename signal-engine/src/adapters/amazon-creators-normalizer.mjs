import { canonicalKey, productTypeFromTitle } from "../core/normalize.mjs";

const DEFAULT_CONTENT_TTL_MS = 60 * 60 * 1000;
const IN_STOCK_TYPES = new Set(["IN_STOCK", "INSTOCK", "INSTOCKSCARCE", "IN_STOCK_SCARCE"]);
const OUT_OF_STOCK_TYPES = new Set(["OUT_OF_STOCK", "OUTOFSTOCK", "UNAVAILABLE"]);

function normalizeAvailabilityType(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function moneyToPence(money) {
  if (!money || String(money.currency || "").trim().toUpperCase() !== "GBP") return null;
  const amount = Number(money.amount);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

function preferredImageUrl(item) {
  const primary = item?.images?.primary || {};
  return primary?.large?.url || primary?.medium?.url || primary?.small?.url || null;
}

function conditionValue(listing) {
  return String(listing?.condition?.value || "").trim().toLowerCase();
}

function featuredNewListing(item) {
  const listings = Array.isArray(item?.offersV2?.listings) ? item.offersV2.listings : [];
  const newListings = listings.filter((listing) => {
    const condition = conditionValue(listing);
    return !condition || condition === "new";
  });
  return newListings.find((listing) => listing?.isBuyBoxWinner === true) || newListings[0] || null;
}

function stockState(availabilityType) {
  const normalized = normalizeAvailabilityType(availabilityType);
  if (IN_STOCK_TYPES.has(normalized)) {
    return { stockStatus: "in_stock", stockConfidence: normalized.includes("SCARCE") ? 0.95 : 0.98 };
  }
  if (OUT_OF_STOCK_TYPES.has(normalized)) return { stockStatus: "out_of_stock", stockConfidence: 0.98 };
  return { stockStatus: "unknown", stockConfidence: 0.5 };
}

function marketplaceProductUrl(item, retailer, asin) {
  if (typeof item?.detailPageURL === "string" && item.detailPageURL.trim()) return item.detailPageURL.trim();
  const base = retailer?.baseUrl || "https://www.amazon.co.uk/";
  return new URL(`/dp/${encodeURIComponent(asin)}`, base).toString();
}

export function normalizeAmazonCreatorsItem(item, retailer, {
  observedAt = new Date(),
  contentTtlMs = DEFAULT_CONTENT_TTL_MS,
} = {}) {
  const asin = String(item?.asin || "").trim();
  const title = String(item?.itemInfo?.title?.displayValue || "").trim();
  if (!asin || !title) return null;

  const listing = featuredNewListing(item);
  const availabilityType = normalizeAvailabilityType(listing?.availability?.type);
  const { stockStatus, stockConfidence } = stockState(availabilityType);
  const merchantName = String(listing?.merchantInfo?.name || "").trim() || null;
  const priceMoney = listing?.price?.money || null;
  const priceCurrency = String(priceMoney?.currency || "").trim().toUpperCase() || null;
  const pricePence = moneyToPence(priceMoney);
  const productType = productTypeFromTitle(title);
  const observedAtDate = observedAt instanceof Date ? observedAt : new Date(observedAt);
  const observedAtMs = Number.isFinite(observedAtDate.getTime()) ? observedAtDate.getTime() : Date.now();
  const contentObservedAt = new Date(observedAtMs).toISOString();
  const ttlMs = Number.isFinite(contentTtlMs) && contentTtlMs > 0 ? contentTtlMs : DEFAULT_CONTENT_TTL_MS;
  const contentExpiresAt = new Date(observedAtMs + ttlMs).toISOString();

  const evidence = [
    { kind: "amazon_asin", value: asin },
    { kind: "amazon_creators_api", value: "offersV2.featured_listing" },
    { kind: "amazon_content_observed_at", value: contentObservedAt },
    { kind: "amazon_content_expires_at", value: contentExpiresAt },
  ];
  if (merchantName) evidence.push({ kind: "amazon_merchant", value: merchantName });
  if (availabilityType) evidence.push({ kind: "amazon_availability", value: availabilityType });
  if (priceCurrency) evidence.push({ kind: "amazon_price_currency", value: priceCurrency });

  return {
    retailerSku: asin,
    title,
    url: marketplaceProductUrl(item, retailer, asin),
    imageUrl: preferredImageUrl(item),
    pricePence,
    postagePence: null,
    gtin: null,
    productType,
    canonicalKey: canonicalKey(title, productType),
    stockStatus,
    stockConfidence,
    stockQuantity: null,
    sellerName: merchantName,
    evidence,
    providerContent: {
      provider: "amazon_creators_api",
      marketplace: retailer?.catalogue?.marketplace || "www.amazon.co.uk",
      asin,
      merchantName,
      availabilityType: availabilityType || null,
      priceCurrency,
      retentionClass: "ephemeral_offer",
      observedAt: contentObservedAt,
      expiresAt: contentExpiresAt,
    },
  };
}

export function normalizeAmazonCreatorsSearchPayload(payload, retailer, options = {}) {
  const items = Array.isArray(payload?.searchResult?.items) ? payload.searchResult.items : [];
  return items
    .map((item) => normalizeAmazonCreatorsItem(item, retailer, options))
    .filter(Boolean);
}

export const __test = {
  DEFAULT_CONTENT_TTL_MS,
  normalizeAvailabilityType,
  stockState,
  featuredNewListing,
};
