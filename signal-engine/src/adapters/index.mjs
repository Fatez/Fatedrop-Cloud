import { scanAmazonCreatorsCatalogue } from "./amazon-creators-adapter.mjs";
import { scanBigCommerceSitemapCatalogue } from "./bigcommerce-sitemap-adapter.mjs";
import { scanRetailerCatalogue } from "./catalogue-adapter.mjs";
import { scanStructuredCatalogue } from "./structured-catalogue-adapter.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";

export function retailerScannerKind(retailer) {
  if ([ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer?.adapterType)) {
    return "structured";
  }

  if (retailer?.adapterType === ADAPTER_TYPES.STRUCTURED_FEED && retailer?.catalogue?.provider === "amazon_creators_api") {
    return "amazon_creators";
  }

  if (!retailer?.adapterType || retailer.adapterType === ADAPTER_TYPES.GENERIC_HTML) {
    // Magic Madhouse's bounded category surface can omit older/restocked products
    // from server-rendered catalogue HTML. Its official product sitemap plus
    // direct product pages are the stronger stock-truth path.
    if (retailer?.id === "magic-madhouse" && retailer.catalogue?.sitemapUrl) return "sitemap";

    // A bounded retailer/category catalogue is authoritative for runtime routing
    // whenever one is explicitly configured. Sitemap crawling is fallback-only.
    if (Array.isArray(retailer.catalogueUrls) && retailer.catalogueUrls.length > 0) return "generic";
    if (retailer.catalogue?.sitemapUrl) return "sitemap";
    return "generic";
  }

  if (retailer?.catalogue?.sitemapUrl) return "sitemap";
  return "unsupported";
}

export async function scanRetailerSource(retailer, options = {}) {
  const scanner = retailerScannerKind(retailer);
  if (scanner === "structured") return scanStructuredCatalogue(retailer, options);
  if (scanner === "amazon_creators") return scanAmazonCreatorsCatalogue(retailer, options);
  if (scanner === "generic") return scanRetailerCatalogue(retailer);
  if (scanner === "sitemap") return scanBigCommerceSitemapCatalogue(retailer);
  throw new Error(`No automatic scanner is enabled for adapter type: ${retailer.adapterType}`);
}
