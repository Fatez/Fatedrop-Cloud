import test from "node:test";
import assert from "node:assert/strict";
import { candidateFromDiscoveryRecord } from "../src/retailers/discovery-intake.mjs";
import { mergeRetailerCandidates } from "../src/retailers/discovery.mjs";
import { normalizeRetailerCandidate, publicRetailerProfile, qualifyRetailer } from "../src/retailers/registry.mjs";

test("UK retailers remain UK-accessible by default", () => {
  const retailer = normalizeRetailerCandidate({
    name: "UK Cards",
    websiteUrl: "https://uk.example",
    catalogue: { urls: ["https://uk.example/pokemon"] },
  });
  assert.equal(retailer.countryCode, "GB");
  assert.equal(retailer.delivery.shipsToUk, true);
  assert.equal(retailer.delivery.currency, "GBP");
  assert.equal(qualifyRetailer(retailer).eligible, true);
});

test("overseas retailers stay candidates until UK shipping is confirmed", () => {
  const retailer = normalizeRetailerCandidate({
    name: "US Cards",
    websiteUrl: "https://us.example",
    countryCode: "US",
    catalogue: { urls: ["https://us.example/pokemon"] },
    delivery: { currency: "USD" },
  });
  const qualification = qualifyRetailer(retailer);
  assert.equal(retailer.countryCode, "US");
  assert.equal(retailer.delivery.shipsToUk, null);
  assert.equal(retailer.delivery.currency, "USD");
  assert.equal(qualification.eligible, false);
  assert.ok(qualification.reasons.includes("uk-shipping-not-confirmed"));
});

test("overseas retailer can qualify when retailer-owned evidence confirms UK delivery", () => {
  const retailer = candidateFromDiscoveryRecord({
    name: "EU Cards",
    websiteUrl: "https://eu.example",
    countryCode: "NL",
    catalogueUrl: "https://eu.example/pokemon",
    adapterType: "generic_html",
    delivery: {
      shipsToUk: true,
      known: true,
      standardPence: 899,
      currency: "EUR",
      dutiesIncluded: true,
      sourceUrl: "https://eu.example/shipping",
    },
  }, { type: "manual_research", name: "Retailer shipping policy" });
  const qualification = qualifyRetailer(retailer);
  assert.equal(retailer.countryCode, "NL");
  assert.equal(retailer.delivery.shipsToUk, true);
  assert.equal(retailer.delivery.currency, "EUR");
  assert.equal(qualification.eligible, true);
  const profile = publicRetailerProfile(retailer);
  assert.equal(profile.shipsToUk, true);
  assert.equal(profile.countryCode, "NL");
});

test("dedupe preserves UK shipping evidence separately from postage evidence", () => {
  const merged = mergeRetailerCandidates({
    id: "global-cards",
    name: "Global Cards",
    websiteUrl: "https://global.example",
    countryCode: "US",
    catalogue: { urls: ["https://global.example/pokemon"] },
    delivery: { shipsToUk: true, currency: "USD", sourceUrl: "https://global.example/shipping" },
  }, {
    id: "global-cards",
    name: "Global Cards",
    websiteUrl: "https://global.example",
    countryCode: "US",
    catalogue: { urls: ["https://global.example/pokemon"] },
    delivery: { known: true, standardPence: 1299, currency: "USD" },
  });
  assert.equal(merged.delivery.shipsToUk, true);
  assert.equal(merged.delivery.known, true);
  assert.equal(merged.delivery.standardPence, 1299);
  assert.equal(merged.delivery.currency, "USD");
});
