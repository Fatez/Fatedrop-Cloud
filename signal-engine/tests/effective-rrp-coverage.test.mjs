import test from "node:test";
import assert from "node:assert/strict";
import { buildEffectiveRrpCoverage, loadEffectiveRrpCoverage } from "../src/telemetry/effective-rrp-coverage.mjs";

const products = [
  { id: "etb", title: "Pokemon TCG Destined Rivals Elite Trainer Box", productType: "elite_trainer_box", tcg: "pokemon", officialRrpPence: 4999, rrpSource: "pokemon-center-uk", rrpObservedAt: 100 },
  { id: "loose-pack-authority", title: "Pokemon TCG Scarlet Violet 10 Destined Rivals Booster Pack", productType: "booster_pack", tcg: "pokemon", officialRrpPence: 429, rrpSource: "asmodee-uk", rrpObservedAt: 100 },
  { id: "bundle", title: "Destined Rivals - 10 Pack Bundle — Sealed", productType: "other", tcg: "pokemon", officialRrpPence: null, rrpSource: null },
  { id: "pack-alias", title: "Pokemon TCG Destined Rivals Booster Pack", productType: "booster_pack", tcg: "pokemon", officialRrpPence: null, rrpSource: null },
  { id: "unknown", title: "Mystery Pokemon Product", productType: "other", tcg: "pokemon", officialRrpPence: null, rrpSource: null },
];

const offers = [
  { offerId: "offer-etb", productId: "etb", retailerId: "retailer-live", title: products[0].title, stockStatus: "in_stock", pricePence: 5999 },
  { offerId: "offer-bundle", productId: "bundle", retailerId: "retailer-live", title: products[2].title, stockStatus: "in_stock", pricePence: 16695 },
  { offerId: "offer-pack", productId: "pack-alias", retailerId: "retailer-live", title: products[3].title, stockStatus: "preorder", pricePence: 499 },
  { offerId: "offer-unknown", productId: "unknown", retailerId: "retailer-live", title: products[4].title, stockStatus: "low_stock", pricePence: 1200 },
  { offerId: "offer-sold", productId: "etb", retailerId: "retailer-live", title: products[0].title, stockStatus: "out_of_stock", pricePence: 4999 },
];

test("effective RRP coverage measures the same official/reference resolver users actually receive", () => {
  const result = buildEffectiveRrpCoverage({ offers, products });
  assert.equal(result.liveOffers, 4);
  assert.equal(result.resolvedOffers, 3);
  assert.equal(result.unresolvedOffers, 1);
  assert.equal(result.coveragePercent, 75);
  assert.equal(result.directVerifiedLinkedOffers, 1);
  assert.equal(result.resolverLiftOffers, 2);
  assert.deepEqual(result.byKind, { official: 1, component_reference: 1, pack_reference: 1 });
  assert.equal(result.byProductType.elite_trainer_box.coveragePercent, 100);
  assert.equal(result.byProductType.booster_pack.coveragePercent, 100);
  assert.equal(result.byProductType.other.coveragePercent, 50);
});

test("effective coverage loader measures only fresh healthy retailer evidence", async () => {
  const calls = [];
  const staleOffer = { ...offers[0], offerId: "offer-stale", retailerId: "retailer-stale" };
  const store = {
    async listOffers(options) { calls.push(["offers", options]); return [...offers, staleOffer]; },
    async listProducts(options) { calls.push(["products", options]); return products; },
    async listRetailers() {
      calls.push(["retailers"]);
      return [
        { id: "retailer-live", healthy: true, stale: false },
        { id: "retailer-stale", healthy: true, stale: true },
      ];
    },
  };
  const result = await loadEffectiveRrpCoverage(store);
  assert.equal(result.available, true);
  assert.equal(result.evidenceScope, "fresh_healthy_retailers");
  assert.equal(result.liveOffers, 4);
  assert.equal(result.coveragePercent, 75);
  assert.deepEqual(calls, [["offers", { limit: 10_000 }], ["retailers"], ["products", { limit: 5_000 }]]);
});

test("effective coverage fails closed when retailer health cannot be read", async () => {
  const store = {
    async listOffers() { return offers; },
    async listProducts() { return products; },
    async listRetailers() { throw new Error("health unavailable"); },
  };
  const result = await loadEffectiveRrpCoverage(store);
  assert.equal(result.available, true);
  assert.equal(result.evidenceScope, "fresh_healthy_retailers");
  assert.equal(result.liveOffers, 0);
  assert.equal(result.resolvedOffers, 0);
});

test("effective coverage exposes aggregate counts only, not product or retailer details", () => {
  const serialized = JSON.stringify(buildEffectiveRrpCoverage({ offers, products }));
  assert.equal(serialized.includes("Destined Rivals"), false);
  assert.equal(serialized.includes("offer-etb"), false);
  assert.equal(serialized.includes("pokemon-center-uk"), false);
});