import test from "node:test";
import assert from "node:assert/strict";
import { RETAILER_STATES, normalizeRetailerCandidate } from "../src/retailers/registry.mjs";
import { transitionRetailer, validateRetailerTransition } from "../src/retailers/lifecycle.mjs";
import { enabledDiscoverySources } from "../src/retailers/uk-discovery-source-catalogue.mjs";

const candidate = normalizeRetailerCandidate({
  name: "Example Cards",
  websiteUrl: "https://examplecards.co.uk/",
  catalogue: { urls: ["https://examplecards.co.uk/pokemon"] },
});

test("candidate cannot jump directly to monitored", () => {
  const result = validateRetailerTransition(candidate, RETAILER_STATES.MONITORED, {
    adapterQualified: true,
    dryRunComplete: true,
    catalogueComplete: true,
    stockMappingValidated: true,
    explicitMonitoringApproval: true,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((reason) => reason.includes("transition-not-allowed")));
});

test("ready retailer needs explicit monitoring approval", () => {
  const ready = normalizeRetailerCandidate({ ...candidate, state: RETAILER_STATES.READY });
  const evidence = { adapterQualified: true, dryRunComplete: true, catalogueComplete: true, stockMappingValidated: true };
  assert.equal(validateRetailerTransition(ready, RETAILER_STATES.MONITORED, evidence).allowed, false);
  const monitored = transitionRetailer(ready, RETAILER_STATES.MONITORED, { ...evidence, explicitMonitoringApproval: true });
  assert.equal(monitored.state, RETAILER_STATES.MONITORED);
});

test("third-party discovery directories are disabled for automation until reviewed", () => {
  assert.equal(enabledDiscoverySources().length, 0);
});
