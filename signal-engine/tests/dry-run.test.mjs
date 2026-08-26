import test from "node:test";
import assert from "node:assert/strict";
import { dryRunRetailer, summariseDryRun } from "../src/retailers/dry-run.mjs";
import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "../src/retailers/registry.mjs";
import { retailerToRuntimeConfig } from "../src/retailers/runtime.mjs";

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
  assert.match(result.note, /no product, offer, signal, health.*registry state is written/i);
});

test("unapproved Shopify candidate can be inspected only through explicit dry-run path", async () => {
  const candidate = normalizeRetailerCandidate({
    name: "Dormant Indie",
    websiteUrl: "https://indie.example",
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.CANDIDATE,
    catalogue: { feedUrl: "https://indie.example/products.json?limit=250", feedApproved: false },
  });

  let scannerOptions = null;
  const result = await dryRunRetailer(candidate, {
    scanSource: async (retailer, options) => {
      scannerOptions = options;
      assert.equal(retailer.catalogue.feedApproved, false, "dry run must not silently approve the registry feed");
      return {
        products: [{ title: "Destined Rivals Elite Trainer Box", pricePence: 4999, stockStatus: "in_stock", url: "https://indie.example/products/dr-etb" }],
        pages: [{ status: 200 }],
      };
    },
  });

  assert.equal(scannerOptions.allowUnapprovedFeed, true);
  assert.equal(result.diagnostics.adapterQualified, true);
  assert.match(result.note, /approval.*registry state is written/i);
});

test("production runtime still refuses an unapproved structured feed", () => {
  const candidate = normalizeRetailerCandidate({
    name: "Unsafe Production Candidate",
    websiteUrl: "https://unsafe.example",
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.MONITORED,
    catalogue: { feedUrl: "https://unsafe.example/products.json", feedApproved: false },
  });
  assert.throws(() => retailerToRuntimeConfig(candidate), /structured feed is not approved/i);
});
