import { scanBigCommerceSitemapCatalogue } from "./bigcommerce-sitemap-adapter.mjs";
import { scanRetailerCatalogue } from "./catalogue-adapter.mjs";
import { scanStructuredCatalogue } from "./structured-catalogue-adapter.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";

export async function scanRetailerSource(retailer, options = {}) {
  if ([ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer.adapterType)) {
    return scanStructuredCatalogue(retailer, options);
  }

  if (!retailer.adapterType || retailer.adapterType === ADAPTER_TYPES.GENERIC_HTML) {
    // Prefer a bounded retailer/category catalogue when one is explicitly
    // configured. Sitemap crawling is a fallback for retailers without a
    // usable category surface; it must not silently turn a bounded scan into
    // hundreds of individual product-page requests.
    if (Array.isArray(retailer.catalogueUrls) && retailer.catalogueUrls.length > 0) {
      return scanRetailerCatalogue(retailer);
    }
    if (retailer.catalogue?.sitemapUrl) {
      return scanBigCommerceSitemapCatalogue(retailer);
    }
    return scanRetailerCatalogue(retailer);
  }

  if (retailer.catalogue?.sitemapUrl) {
    return scanBigCommerceSitemapCatalogue(retailer);
  }

  throw new Error(`No automatic scanner is enabled for adapter type: ${retailer.adapterType}`);
}
