import { fetchStructuredJson, sleep } from "../core/fetch.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";
import { normalizeShopifyProducts } from "./shopify-normalizer.mjs";
import { normalizeWooStoreProducts } from "./woocommerce-normalizer.mjs";

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

function shopifyPageUrl(feedUrl, page) {
  const url = new URL(feedUrl);
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "250");
  url.searchParams.set("page", String(page));
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

    for (let page = 1; page <= maxPages; page += 1) {
      const pageUrl = shopifyPageUrl(retailer.catalogue.feedUrl, page);
      const { payload, status } = await fetchStructuredJson(pageUrl);
      const rawCount = Array.isArray(payload?.products) ? payload.products.length : 0;
      const products = filterProducts(normalizeShopifyProducts(payload, retailer), retailer);
      for (const product of products) found.set(product.retailerSku, product);
      pages.push({ pageUrl, discovered: products.length, status });
      if (rawCount === 0 || rawCount < 250) break;
      if (page < maxPages) await sleep(delayMs);
    }

    return { products: [...found.values()], pages };
  }

  const { payload, status } = await fetchStructuredJson(retailer.catalogue.feedUrl);
  let products;
  if (retailer.adapterType === ADAPTER_TYPES.WOOCOMMERCE) products = normalizeWooStoreProducts(payload, retailer);
  else throw new Error(`Unsupported structured adapter: ${retailer.adapterType}`);
  products = filterProducts(products, retailer);
  return {
    products,
    pages: [{ pageUrl: retailer.catalogue.feedUrl, discovered: products.length, status }],
  };
}
