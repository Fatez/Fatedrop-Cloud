import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_TYPES, RETAILER_STATES, normalizeRetailerCandidate } from "../src/retailers/registry.mjs";
import { transitionRetailer, validateRetailerTransition } from "../src/retailers/lifecycle.mjs";
import { retailerToRuntimeConfig, selectRuntimeRetailers } from "../src/retailers/runtime.mjs";
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

test("runtime follows canonical registry state even for statically configured retailers", () => {
  const staticMonitored = { id: "static-monitored", name: "Static monitored", adapterType: ADAPTER_TYPES.BROWSER_COLLECTOR };
  const staticCandidate = { id: "static-candidate", name: "Static candidate", adapterType: ADAPTER_TYPES.GENERIC_HTML };
  const dynamicMonitored = normalizeRetailerCandidate({
    ...genericCandidate,
    id: "dynamic-monitored",
    state: RETAILER_STATES.MONITORED,
  });
  const selected = selectRuntimeRetailers({
    staticRetailers: [staticMonitored, staticCandidate],
    registryRetailers: [
      normalizeRetailerCandidate({ id: staticMonitored.id, name: staticMonitored.name, websiteUrl: "https://static.example", state: RETAILER_STATES.MONITORED }),
      normalizeRetailerCandidate({ id: staticCandidate.id, name: staticCandidate.name, websiteUrl: "https://candidate.example", state: RETAILER_STATES.CANDIDATE }),
      dynamicMonitored,
    ],
  });
  assert.deepEqual(selected.map((retailer) => retailer.id).sort(), ["dynamic-monitored", "static-monitored"]);
  assert.equal(selected.find((retailer) => retailer.id === "static-monitored"), staticMonitored);
});

test("third-party discovery directories are disabled for automation until reviewed", () => {
  assert.equal(enabledDiscoverySources().length, 0);
});
