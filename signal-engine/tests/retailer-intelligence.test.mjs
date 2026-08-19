import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_TYPES, RETAILER_CLASSES, normalizeRetailerCandidate, qualifyRetailer } from "../src/retailers/registry.mjs";
import { inferAdapterFromEvidence, onboardingPlan, shouldPublishCatalogue } from "../src/retailers/onboarding.mjs";
import { calculateOfferIntelligence, sortOffersByTruePrice, summariseMarketOffers } from "../src/core/price-intelligence.mjs";

test("normalises a UK indie retailer without manufacturing verification", () => {
  const retailer = normalizeRetailerCandidate({ name: "Example Cards", websiteUrl: "https://www.examplecards.co.uk", retailerClass: RETAILER_CLASSES.INDEPENDENT, catalogue: { urls: ["https://www.examplecards.co.uk/pokemon"] } });
  assert.equal(retailer.id, "examplecards-co-uk");
  assert.equal(retailer.countryCode, "GB");
  assert.equal(retailer.verification, "unverified");
  assert.equal(retailer.delivery.known, false);
});

test("qualification requires a usable catalogue entrypoint", () => {
  const failed = qualifyRetailer({ name: "Store", websiteUrl: "https://store.example" });
  assert.equal(failed.eligible, false);
  assert.ok(failed.reasons.includes("no-catalogue-entrypoint"));
  const passed = qualifyRetailer({ name: "Store", websiteUrl: "https://store.example", catalogue: { urls: ["https://store.example/pokemon"] } });
  assert.equal(passed.eligible, true);
});

test("adapter inference recognises common retailer platforms", () => {
  assert.equal(inferAdapterFromEvidence({ html: "cdn.shopify.com theme" }), ADAPTER_TYPES.SHOPIFY);
  assert.equal(inferAdapterFromEvidence({ html: "wp-content/plugins/woocommerce" }), ADAPTER_TYPES.WOOCOMMERCE);
  assert.equal(inferAdapterFromEvidence({ feedUrls: ["https://x.example/catalogue.csv"] }), ADAPTER_TYPES.CSV);
});

test("onboarding plan keeps commercial trust separate from monitoring readiness", () => {
  const plan = onboardingPlan({ name: "Indie", websiteUrl: "https://indie.example", catalogue: { urls: ["https://indie.example/cards"] } });
  assert.equal(plan.readyForMonitoring, false);
  assert.ok(plan.tasks.includes("verify-business-identity"));
  assert.ok(plan.tasks.includes("capture-delivery-policy"));
  assert.ok(plan.tasks.includes("dry-run-catalogue"));
});

test("incomplete catalogue scans never replace the last complete state", () => {
  assert.equal(shouldPublishCatalogue({ previousCompleteCount: 1000, observedCount: 200, explicitlyComplete: true }).publish, false);
  assert.equal(shouldPublishCatalogue({ previousCompleteCount: 1000, observedCount: 980, explicitlyComplete: true }).publish, true);
  assert.equal(shouldPublishCatalogue({ observedCount: 980, explicitlyComplete: false }).publish, false);
});

test("True Price never treats unknown postage as free", () => {
  const unknown = calculateOfferIntelligence({ pricePence: 4999, postagePence: null, officialRrpPence: 4999 });
  assert.equal(unknown.deliveryKnown, false);
  assert.equal(unknown.deliveredPence, null);
  assert.equal(unknown.deliveredVsRrp.deltaPercent, null);
});

test("price intelligence objectively exposes above-RRP offers", () => {
  const intelligence = calculateOfferIntelligence({ pricePence: 7999, postagePence: 399, officialRrpPence: 5999, rrpSource: "official", rrpObservedAt: "2026-08-19T00:00:00Z" });
  assert.equal(intelligence.itemVsRrp.aboveRrp, true);
  assert.ok(intelligence.itemVsRrp.deltaPercent > 33 && intelligence.itemVsRrp.deltaPercent < 34);
  assert.equal(intelligence.deliveredPence, 8398);
});

test("offers sort by known delivered price before unknown delivery", () => {
  const offers = [
    { id: "unknown", pricePence: 4500, intelligence: calculateOfferIntelligence({ pricePence: 4500 }) },
    { id: "known-b", pricePence: 5200, intelligence: calculateOfferIntelligence({ pricePence: 5200, postagePence: 0 }) },
    { id: "known-a", pricePence: 4900, intelligence: calculateOfferIntelligence({ pricePence: 4900, postagePence: 299 }) },
  ];
  assert.deepEqual(sortOffersByTruePrice(offers).map((item) => item.id), ["known-b", "known-a", "unknown"]);
});

test("market summary counts above-RRP offers without retailer ranking", () => {
  const offers = [
    { pricePence: 5000, intelligence: calculateOfferIntelligence({ pricePence: 5000, postagePence: 0, officialRrpPence: 5000 }) },
    { pricePence: 6500, intelligence: calculateOfferIntelligence({ pricePence: 6500, postagePence: 300, officialRrpPence: 5000 }) },
  ];
  const summary = summariseMarketOffers(offers);
  assert.equal(summary.offerCount, 2);
  assert.equal(summary.aboveRrpCount, 1);
  assert.equal(summary.cheapestDeliveredPence, 5000);
  assert.equal(summary.highestItemPremiumPercent, 30);
});
