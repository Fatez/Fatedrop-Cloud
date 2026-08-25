import test from "node:test";
import assert from "node:assert/strict";

import { processRetailerProducts } from "../src/core/engine.mjs";
import { buildRrpValueContext, resolveRrpValue } from "../src/core/rrp-value-reference.mjs";

const VERIFIED_CHAOS_RISING_BOX = {
  id: "pcuk-chaos-rising-box",
  canonicalKey: "booster_box:mega evolution chaos rising booster display box 36 packs",
  title: "Pokémon TCG: Mega Evolution-Chaos Rising Booster Display Box (36 Packs)",
  productType: "booster_box",
  tcg: "pokemon",
  officialRrpPence: 15199,
  rrpSource: "pokemon-center-uk",
  rrpObservedAt: 1_787_313_615,
  firstSeenAt: 1_787_313_615,
  updatedAt: 1_787_313_615,
};

test("Chaos Rising ME04 booster-box alias resolves to verified 36-pack official RRP", () => {
  const context = buildRrpValueContext([VERIFIED_CHAOS_RISING_BOX]);
  const result = resolveRrpValue({
    title: "Pokemon TCG: Chaos Rising ME04 - Booster Box",
    productType: "booster_box",
    tcg: "pokemon",
  }, context);

  assert.equal(result.resolved, true);
  assert.equal(result.kind, "official");
  assert.equal(result.rrpPence, 15199);
  assert.equal(result.rrpSource, "pokemon-center-uk");
  assert.deepEqual(result.matchedProductIds, ["pcuk-chaos-rising-box"]);
});

test("omitted booster-box pack count stays fail-closed when canonical configurations disagree", () => {
  const context = buildRrpValueContext([
    VERIFIED_CHAOS_RISING_BOX,
    {
      ...VERIFIED_CHAOS_RISING_BOX,
      id: "alternate-chaos-rising-box",
      title: "Pokémon TCG: Mega Evolution-Chaos Rising Booster Display Box (18 Packs)",
      officialRrpPence: 8999,
      rrpSource: "verified-other-authority",
    },
  ]);

  const result = resolveRrpValue({
    title: "Pokemon TCG: Chaos Rising ME04 - Booster Box",
    productType: "booster_box",
    tcg: "pokemon",
  }, context);

  assert.equal(result.resolved, false);
  assert.equal(result.reason, "no_exact_identity_match");
});

test("Double Sleeved Chaos Rising Manifested signal inherits RRP and computes the comparison", async () => {
  let saved = null;
  const store = {
    isBaselineComplete: async () => true,
    listProducts: async () => [VERIFIED_CHAOS_RISING_BOX],
    getProduct: async () => null,
    getOffer: async () => null,
    saveScan: async (payload) => { saved = payload; },
  };

  const result = await processRetailerProducts({
    retailer: { id: "double-sleeved", name: "Double Sleeved", tcg: "pokemon", delivery: { known: false } },
    store,
    source: "external",
    dispatchNotifications: false,
    now: 1_787_674_443,
    rawProducts: [{
      retailerSku: "57137626448249",
      title: "Pokemon TCG: Chaos Rising ME04 - Booster Box",
      url: "https://example.com/chaos-rising",
      pricePence: 17995,
      postagePence: 0,
      stockStatus: "in_stock",
      stockConfidence: 0.98,
    }],
  });

  assert.equal(result.rrpInherited, 1);
  assert.ok(saved);
  assert.equal(saved.products[0].officialRrpPence, 15199);
  assert.equal(saved.offers[0].rrpPence, 15199);
  assert.equal(saved.signals.length, 1);
  assert.equal(saved.signals[0].state, "manifested");
  assert.equal(saved.signals[0].rrpPence, 15199);
  assert.ok(Math.abs(saved.signals[0].markupPercent - 18.4) < 0.01);
});
