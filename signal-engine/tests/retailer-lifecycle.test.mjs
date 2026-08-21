import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "../src/retailers/registry.mjs";
import { transitionRetailer, validateRetailerTransition } from "../src/retailers/lifecycle.mjs";
import { retailerToRuntimeConfig } from "../src/retailers/runtime.mjs";
import { enabledDiscoverySources } from "../src/retailers/uk-discovery-source-catalogue.mjs";

const genericCandidate = normalizeRetailerCandidate({
  name: "Example Cards",
  websiteUrl: "https://examplecards.co.uk/",
  catalogue: {
    urls: ["https://examplecards.co.uk/pokemon"],
    runtime: {
      productUrlPattern: "examplecards\\.co\\.uk/products/",
      skuPattern: "/products/([^/?#]+)",
    },
  },
});

const readinessEvidence = {
  adapterQualified: true,
  dryRunComplete: true,
  catalogueComplete: true,
  stockMappingValidated: true,
};

test("candidate cannot jump directly to monitored", () => {
  const result = validateRetailerTransition(genericCandidate, RETAILER_STATES.MONITORED, {
    ...readinessEvidence,
    explicitMonitoringApproval: true,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.includes("transition-not-allowed")));
});

test("ready retailer needs explicit monitoring approval", () => {
  const ready = normalizeRetailerCandidate({ ...genericCandidate, state: RETAILER_STATES.READY });
  assert.equal(validateRetailerTransition(ready, RETAILER_STATES.MONITORED, readinessEvidence).allowed, false);
  const monitored = transitionRetailer(ready, RETAILER_STATES.MONITORED, { ...readinessEvidence, explicitMonitoringApproval: true });
  assert.equal(monitored.state, RETAILER_STATES.MONITORED);
});

test("structured retailer cannot become ready until the exact feed is approved", () => {
  const shopify = normalizeRetailerCandidate({
    name: "Structured Cards",
    websiteUrl: "https://structured.example/",
    adapterType: ADAPTER_TYPES.SHOPIFY,
    state: RETAILER_STATES.QUALIFYING,
    catalogue: { feedUrl: "https://structured.example/products.json", feedApproved: false },
  });
  const result = validateRetailerTransition(shopify, RETAILER_STATES.READY, readinessEvidence);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("structured-feed-approval-required"));
});

test("monitored generic retailer compiles into runtime scanner config", () => {
  const monitored = normalizeRetailerCandidate({ ...genericCandidate, state: RETAILER_STATES.MONITORED });
  const runtime = retailerToRuntimeConfig(monitored);
  assert.equal(runtime.id, genericCandidate.id);
  assert.equal(runtime.tcg, "pokemon");
  assert.ok(runtime.productUrlPattern.test("https://examplecards.co.uk/products/example-etb"));
});

test("overseas monitored retailer is blocked until UK shipping is confirmed", () => {
  const monitored = normalizeRetailerCandidate({
    ...genericCandidate,
    id: "us-cards",
    websiteUrl: "https://uscards.example/",
    countryCode: "US",
    state: RETAILER_STATES.MONITORED,
    delivery: { currency: "GBP" },
    catalogue: {
      urls: ["https://uscards.example/pokemon"],
      runtime: {
        productUrlPattern: "uscards\\.example/products/",
        skuPattern: "/products/([^/?#]+)",
      },
    },
  });
  assert.throws(() => retailerToRuntimeConfig(monitored), /UK shipping is confirmed/i);
});

test("international monitored retailer is blocked until landed-cost conversion exists", () => {
  const monitored = normalizeRetailerCandidate({
    ...genericCandidate,
    id: "eu-cards",
    websiteUrl: "https://eucards.example/",
    countryCode: "NL",
    state: RETAILER_STATES.MONITORED,
    delivery: { shipsToUk: true, currency: "EUR" },
    catalogue: {
      urls: ["https://eucards.example/pokemon"],
      runtime: {
        productUrlPattern: "eucards\\.example/products/",
        skuPattern: "/products/([^/?#]+)",
      },
    },
  });
  assert.throws(() => retailerToRuntimeConfig(monitored), /international FX.*landed-cost conversion/i);
});

test("third-party discovery directories are disabled for automation until reviewed", () => {
  assert.equal(enabledDiscoverySources().length, 0);
});
