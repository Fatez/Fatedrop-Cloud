import { scanRetailerSource } from "../adapters/index.mjs";
import { shouldPublishCatalogue } from "./onboarding.mjs";
import { retailerToAdapterConfig } from "./runtime.mjs";

export function summariseDryRun({ retailer, products = [], pages = [], previousCompleteCount = null } = {}) {
  const total = products.length;
  const withPrice = products.filter((row) => Number.isFinite(row.pricePence)).length;
  const knownStock = products.filter((row) => row.stockStatus && row.stockStatus !== "unknown").length;
  const unknownStock = total - knownStock;
  const stockCoverage = total ? knownStock / total : 0;
  const priceCoverage = total ? withPrice / total : 0;
  const completeness = shouldPublishCatalogue({
    previousCompleteCount,
    observedCount: total,
    expectedMinimumProducts: retailer?.monitoring?.expectedMinimumProducts ?? null,
    explicitlyComplete: total > 0,
  });
  return {
    retailerId: retailer?.id || null,
    productsObserved: total,
    pagesScanned: pages.length,
    priceCoverage,
    stockCoverage,
    unknownStock,
    catalogueComplete: completeness.publish,
    completenessReason: completeness.reason,
    adapterQualified: total > 0,
    dryRunComplete: total > 0,
    stockMappingValidated: total > 0 && stockCoverage >= 0.8,
    sample: products.slice(0, 5).map((row) => ({ title: row.title, pricePence: row.pricePence, stockStatus: row.stockStatus, url: row.url })),
  };
}

export async function dryRunRetailer(input, { previousCompleteCount = null, scanSource = scanRetailerSource } = {}) {
  const retailer = retailerToAdapterConfig(input, { requireMonitored: false });
  const { products, pages } = await scanSource(retailer);
  return {
    retailer,
    diagnostics: summariseDryRun({ retailer, products, pages, previousCompleteCount }),
    note: "Dry run only. No product, offer, signal, health or registry state is written.",
  };
}
