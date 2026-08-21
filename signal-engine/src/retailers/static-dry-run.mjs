import { scanRetailerSource } from "../adapters/index.mjs";
import { ADAPTER_TYPES } from "./registry.mjs";
import { summariseDryRun } from "./dry-run.mjs";

const SUPPORTED_STATIC_DRY_RUN_ADAPTERS = new Set([
  ADAPTER_TYPES.SHOPIFY,
  ADAPTER_TYPES.WOOCOMMERCE,
  ADAPTER_TYPES.GENERIC_HTML,
]);

export function validateStaticDryRunRetailer(retailer) {
  if (!retailer?.id) throw new Error("Configured retailer id is required");
  if (retailer.adapterType === ADAPTER_TYPES.BROWSER_COLLECTOR) {
    throw new Error(`${retailer.id} uses a browser collector and must be diagnosed through its dedicated collector workflow`);
  }
  if (!SUPPORTED_STATIC_DRY_RUN_ADAPTERS.has(retailer.adapterType)) {
    throw new Error(`${retailer.id} adapter ${retailer.adapterType || "unknown"} is not supported by static dry-run diagnostics`);
  }
  return retailer;
}

export async function dryRunStaticRetailer(retailer, { scanSource = scanRetailerSource, previousCompleteCount = null } = {}) {
  const configured = validateStaticDryRunRetailer(retailer);
  const { products, pages } = await scanSource(configured);
  return {
    retailerId: configured.id,
    retailerName: configured.name,
    adapterType: configured.adapterType,
    diagnostics: summariseDryRun({
      retailer: configured,
      products,
      pages,
      previousCompleteCount,
    }),
    persisted: false,
    published: false,
    note: "Static retailer diagnostic only. No product, offer, signal, health or registry state is written.",
  };
}
