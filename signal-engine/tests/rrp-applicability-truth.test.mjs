import assert from "node:assert/strict";
import test from "node:test";
import { productTypeFromTitle } from "../src/core/normalize.mjs";
import { classifyRrpApplicability } from "../src/core/rrp-applicability.mjs";
import { buildEffectiveRrpCoverage } from "../src/telemetry/effective-rrp-coverage.mjs";

test("digital redemption listings do not masquerade as sealed ETBs", () => {
  assert.equal(productTypeFromTitle("Pokemon Paldean Fates Elite Trainer Box Online Code (Pokemon TCG Live)"), "other");
  assert.equal(productTypeFromTitle("Pokemon Surging Sparks Elite Trainer Box"), "elite_trainer_box");
});

test("obvious non-UK imports and non-standard bundles are excluded from fair UK RRP coverage", () => {
  assert.deepEqual(classifyRrpApplicability({ title: "Pokemon Mega Brave Japanese Booster Box", productType: "booster_box" }), { eligible: false, reason: "non_uk_import" });
  assert.deepEqual(classifyRrpApplicability({ title: "Journey Together Half Booster Box (18 Packs)", productType: "booster_box" }), { eligible: false, reason: "non_standard_bundle" });
  assert.deepEqual(classifyRrpApplicability({ title: "Surging Sparks Elite Trainer Box", productType: "elite_trainer_box" }), { eligible: true, reason: null });
});

test("coverage reports all-market and fair-reference-eligible truth separately", () => {
  const products = [
    { id: "uk-etb", title: "Surging Sparks Elite Trainer Box", productType: "elite_trainer_box", tcg: "pokemon", officialRrpPence: 4999, rrpSource: "asmodee-uk", rrpObservedAt: 100 },
    { id: "uk-box", title: "Battle Styles Booster Box", productType: "booster_box", tcg: "pokemon", officialRrpPence: null, rrpSource: null },
    { id: "jp-box", title: "Mega Brave Japanese Booster Box", productType: "booster_box", tcg: "pokemon", officialRrpPence: null, rrpSource: null },
    { id: "code", title: "Paldean Fates Elite Trainer Box Online Code", productType: "other", tcg: "pokemon", officialRrpPence: null, rrpSource: null },
  ];
  const offers = products.map((product) => ({ productId: product.id, title: product.title, productType: product.productType, stockStatus: "in_stock" }));
  const result = buildEffectiveRrpCoverage({ offers, products });
  assert.equal(result.liveOffers, 4);
  assert.equal(result.resolvedOffers, 1);
  assert.equal(result.coveragePercent, 25);
  assert.equal(result.referenceEligibleOffers, 2);
  assert.equal(result.referenceExcludedOffers, 2);
  assert.equal(result.eligibleResolvedOffers, 1);
  assert.equal(result.eligibleCoveragePercent, 50);
  assert.equal(result.excludedByReason.non_uk_import, 1);
  assert.equal(result.excludedByReason.digital_code, 1);
});
