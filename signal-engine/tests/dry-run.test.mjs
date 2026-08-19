import test from "node:test";
import assert from "node:assert/strict";
import { dryRunRetailer, summariseDryRun } from "../src/retailers/dry-run.mjs";
import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "../src/retailers/registry.mjs";

test("dry-run summary reports price/stock coverage without inventing completeness", () => {
  const retailer = normalizeRetailerCandidate({ name: "Example", websiteUrl: "https://example.test", monitoring: { expectedMinimumProducts: 3 } });
  const report = summariseDryRun({ retailer, products: [
    { title: "A", pricePence: 4999, stockStatus: "in_stock", url: "https://example.test/a" },
    { title: "B", pricePence: null, stockStatus: "unknown", url: "https://example.test/b" },
  ], pages: [{}, {}] });
  assert.equal(report.productsObserved, 2);
  assert.equal(report.catalogueComplete, false);
  assert.equal(report.completenessReason, "below-expected-minimum");
  assert.equal(report.priceCoverage, 0.5);
  assert.equal(report.stockCoverage, 0.5);
  assert.equal(report.stockMappingValidated, false);
});

test("dry run does not require monitored lifecycle state and performs no store writes", async () => {
  const candidate = normalizeRetailerCandidate({
    name: "Structured Example",
    websiteUrl: "https://structured.example",
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.QUALIFYING,
    catalogue: { feedUrl: "https://structured.example/products.json", feedApproved: true },
  });
  const result = await dryRunRetailer(candidate, {
    scanSource: async () => ({ products: [{ title: "ETB", pricePence: 4999, stockStatus: "in_stock", url: "https://structured.example/p" }], pages: [{ status: 200 }] }),
  });
  assert.equal(result.diagnostics.adapterQualified, true);
  assert.match(result.note, /No product, offer, signal, health or registry state is written/i);
});
