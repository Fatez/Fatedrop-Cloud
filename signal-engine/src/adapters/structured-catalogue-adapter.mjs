import { fetchStructuredJson, sleep } from "../core/fetch.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";
import { recordCatalogueYield } from "../telemetry/catalogue-yield-context.mjs";
import { normalizeShopifyProducts } from "./shopify-normalizer.mjs";
import { normalizeWooStoreProducts } from "./woocommerce-normalizer.mjs";

const DEFAULT_SHOPIFY_MARKET_COUNTRY = "GB";

function matchesFilter(pattern, value) {
  if (!pattern) return true;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function filterValue(item) {
  let path = "";
  try {
    path = new URL(item.url || "").pathname;
  } catch {
    path = "";
  }
  return `${item.title || ""} ${path}`;
}

function filterProducts(products, retailer) {
  return products
    .filter((item) => matchesFilter(retailer.include, filterValue(item)))
    .filter((item) => {
      if (!retailer.exclude) return true;
      return !matchesFilter(retailer.exclude, filterValue(item));
    });
}

function shopifyMarketCountry(retailer) {
  const configured = String(retailer?.catalogue?.marketCountry || retailer?.marketCountry || "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(configured) ? configured : DEFAULT_SHOPIFY_MARKET_COUNTRY;
}

function shopifyPageUrl(feedUrl, page, marketCountry = DEFAULT_SHOPIFY_MARKET_COUNTRY) {
  const url = new URL(feedUrl);
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "250");
  url.searchParams.set("page", String(page));
  const country = String(marketCountry || DEFAULT_SHOPIFY_MARKET_COUNTRY).trim().toUpperCase();
  url.searchParams.set("country", /^[A-Z]{2}$/.test(country) ? country : DEFAULT_SHOPIFY_MARKET_COUNTRY);
  return url.toString();
}

export async function scanStructuredCatalogue(retailer, { allowUnapprovedFeed = false } = {}) {
  if (!retailer?.catalogue?.feedUrl) throw new Error("Structured catalogue requires an explicit feedUrl");
  if (retailer.catalogue.feedApproved !== true && allowUnapprovedFeed !== true) {
    throw new Error("Structured catalogue feed must be explicitly approved before monitoring");
  }

  if (retailer.adapterType === ADAPTER_TYPES.SHOPIFY) {
    const found = new Map();
    const pages = [];
    const maxPages = Math.max(1, Math.min(100, retailer.catalogue?.runtime?.maxPages || retailer.maxPages || 20));
    const delayMs = Math.max(250, retailer.catalogue?.runtime?.delayMs || retailer.delayMs || 900);
    const marketCountry = shopifyMarketCountry(retailer);
    let complete = false;
    let rawProductsSeen = 0;
    let normalizedProductsSeen = 0;
    let filteredOutProducts = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const pageUrl = shopifyPageUrl(retailer.catalogue.feedUrl, page, marketCountry);
      const { payload, status } = await fetchStructuredJson(pageUrl);
      const rawCount = Array.isArray(payload?.products) ? payload.products.length : 0;
      const normalized = normalizeShopifyProducts(payload, retailer);
      const products = filterProducts(normalized, retailer);
      rawProductsSeen += rawCount;
      normalizedProductsSeen += normalized.length;
      filteredOutProducts += normalized.length - products.length;
      for (const product of products) found.set(product.retailerSku, product);
      pages.push({
        pageUrl,
        discovered: products.length,
        rawCount,
        normalizedCount: normalized.length,
        filteredOut: normalized.length - products.length,
        status,
      });
      if (rawCount === 0 || rawCount < 250) {
        complete = true;
        break;
      }
      if (page < maxPages) await sleep(delayMs);
    }

    const discovery = {
      rawProductsSeen,
      normalizedProductsSeen,
      filteredOutProducts,
      acceptedProductsSeen: found.size,
      pageLimitReached: !complete && pages.length >= maxPages,
    };
    recordCatalogueYield(retailer.id, discovery);
    return {
      products: [...found.values()],
      pages,
      complete,
      partialCatalogue: !complete,
      ...discovery,
    };
  }

  const { payload, status } = await fetchStructuredJson(retailer.catalogue.feedUrl);
  let normalized;
  if (retailer.adapterType === ADAPTER_TYPES.WOOCOMMERCE) normalized = normalizeWooStoreProducts(payload, retailer);
  else throw new Error(`Unsupported structured adapter: ${retailer.adapterType}`);
  const products = filterProducts(normalized, retailer);
  const discovery = {
    rawProductsSeen: Array.isArray(payload) ? payload.length : normalized.length,
    normalizedProductsSeen: normalized.length,
    filteredOutProducts: normalized.length - products.length,
    acceptedProductsSeen: products.length,
    pageLimitReached: false,
  };
  recordCatalogueYield(retailer.id, discovery);
  return {
    products,
    pages: [{ pageUrl: retailer.catalogue.feedUrl, discovered: products.length, normalizedCount: normalized.length, filteredOut: normalized.length - products.length, status }],
    complete: true,
    ...discovery,
  };
}

export const __test = {
  DEFAULT_SHOPIFY_MARKET_COUNTRY,
  shopifyMarketCountry,
  shopifyPageUrl,
};
