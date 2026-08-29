import test from "node:test";
import assert from "node:assert/strict";
import { catalogueCompletenessDecision, previousRetailerProductsSeen } from "../src/core/catalogue-completeness.mjs";

test("normal catalogue movement remains acceptable", () => {
  const result = catalogueCompletenessDecision({ observedProducts: 78, previousProductsSeen: 80 });
  assert.equal(result.acceptable, true);
  assert.equal(result.reason, "complete_enough");
});

test("small catalogues are not quarantined by percentage alone", () => {
  const result = catalogueCompletenessDecision({ observedProducts: 2, previousProductsSeen: 3 });
  assert.equal(result.acceptable, true);
});

test("large sudden catalogue collapse is quarantined", () => {
  const result = catalogueCompletenessDecision({ observedProducts: 4, previousProductsSeen: 80 });
  assert.equal(result.acceptable, false);
  assert.equal(result.reason, "suspicious_catalogue_collapse");
  assert.equal(result.missing, 76);
});

test("configured expected minimum fails closed", () => {
  const result = catalogueCompletenessDecision({
    retailer: { monitoring: { expectedMinimumProducts: 20 } },
    observedProducts: 4,
    previousProductsSeen: null,
  });
  assert.equal(result.acceptable, false);
  assert.equal(result.reason, "below_expected_minimum");
});

test("partial catalogue is quarantined before lifecycle processing", () => {
  const result = catalogueCompletenessDecision({ observedProducts: 12, previousProductsSeen: 20, partialCatalogue: true });
  assert.equal(result.acceptable, false);
  assert.equal(result.reason, "partial_catalogue");
});

test("incomplete replacement requires explicit opt-in", () => {
  const result = catalogueCompletenessDecision({
    retailer: { monitoring: { allowIncompleteReplacement: true } },
    observedProducts: 2,
    previousProductsSeen: 80,
    partialCatalogue: true,
  });
  assert.equal(result.acceptable, true);
  assert.equal(result.reason, "incomplete_replacement_explicitly_allowed");
});

test("previous product count comes from matching retailer health", () => {
  const count = previousRetailerProductsSeen([
    { id: "alpha", productsSeen: 12 },
    { id: "target", productsSeen: 47 },
  ], "target");
  assert.equal(count, 47);
});
