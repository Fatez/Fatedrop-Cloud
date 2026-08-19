import { fetchStructuredJson } from "../core/fetch.mjs";
import { ADAPTER_TYPES } from "../retailers/registry.mjs";
import { normalizeShopifyProducts } from "./shopify-normalizer.mjs";
import { normalizeWooStoreProducts } from "./woocommerce-normalizer.mjs";

export async function scanStructuredCatalogue(retailer) {
  if (!retailer?.catalogue?.feedUrl) throw new Error("Structured catalogue requires an explicit feedUrl");
  if (retailer.catalogue.feedApproved !== true) throw new Error("Structured catalogue feed must be explicitly approved before monitoring");
  const { payload, status } = await fetchStructuredJson(retailer.catalogue.feedUrl);
  let products;
  if (retailer.adapterType === ADAPTER_TYPES.SHOPIFY) products = normalizeShopifyProducts(payload, retailer);
  else if (retailer.adapterType === ADAPTER_TYPES.WOOCOMMERCE) products = normalizeWooStoreProducts(payload, retailer);
  else throw new Error(`Unsupported structured adapter: ${retailer.adapterType}`);
  return {
    products,
    pages: [{ pageUrl: retailer.catalogue.feedUrl, discovered: products.length, status }],
  };
}
