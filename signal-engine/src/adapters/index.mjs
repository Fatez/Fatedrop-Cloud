import { scanBigCommerceSitemapCatalogue } from "./bigcommerce-sitemap-adapter.mjs";
import { scanRetailerCatalogue } from "./catalogue-adapter.mjs";
import { scanStructuredCatalogue } from "./structured-catalogue-adapter.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";

export async function scanRetailerSource(retailer) {
  if (retailer.catalogue?.sitemapUrl) {
    return scanBigCommerceSitemapCatalogue(retailer);
  }
  if ([ADAPTER_TYPES.SHOPIFY, ADAPTER_TYPES.WOOCOMMERCE].includes(retailer.adapterType)) {
    return scanStructuredCatalogue(retailer);
  }
  if (!retailer.adapterType || retailer.adapterType === ADAPTER_TYPES.GENERIC_HTML) {
    return scanRetailerCatalogue(retailer);
  }
  throw new Error(`No automatic scanner is enabled for adapter type: ${retailer.adapterType}`);
}
