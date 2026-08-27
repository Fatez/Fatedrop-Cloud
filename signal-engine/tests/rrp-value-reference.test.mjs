import test from "node:test";
import assert from "node:assert/strict";
import { buildRrpValueContext, resolveRrpValue } from "../src/core/rrp-value-reference.mjs";

const products = [
  {
    id: "destined-rivals-loose-pack",
    title: "Pokémon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 429,
    rrpSource: "asmodee-uk",
    rrpObservedAt: 1_780_000_000,
  },
  {
    id: "destined-rivals-sleeved-pack",
    title: "Pokémon TCG: Scarlet & Violet-Destined Rivals Sleeved Booster Pack (10 Cards)",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 499,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_780_000_050,
  },
  {
    id: "destined-rivals-3pack",
    title: "Pokémon TCG: Scarlet & Violet-Destined Rivals 3 Booster Packs & Kangaskhan Promo Card",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 1399,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_780_000_100,
  },
];

const context = buildRrpValueContext(products);

test("retailer 10-pack loose bundle gets a component reference from verified loose-pack RRP", () => {
  const result = resolveRrpValue({
    title: "Destined Rivals - 10 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, true);
  assert.equal(result.kind, "component_reference");
  assert.equal(result.rrpPence, 4290);
  assert.equal(result.unitCount, 10);
  assert.equal(result.unitRrpPence, 429);
  assert.equal(result.referenceBasis, "10 × verified booster-pack RRP");
  assert.deepEqual(result.matchedProductIds, ["destined-rivals-loose-pack"]);
});

test("retailer 4-pack loose bundle uses the same verified loose-pack unit reference", () => {
  const result = resolveRrpValue({
    title: "Destined Rivals - 4 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, true);
  assert.equal(result.rrpPence, 1716);
  assert.equal(result.unitCount, 4);
  assert.equal(result.unitRrpPence, 429);
});

test("sleeved booster RRP cannot leak into a loose retailer multipack reference", () => {
  const result = resolveRrpValue({
    title: "Destined Rivals - 4 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  }, buildRrpValueContext([products[1]]));
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "no_verified_pack_reference");
});

test("a sleeved booster alias can still use the verified sleeved booster reference", () => {
  const result = resolveRrpValue({
    title: "Pokemon Destined Rivals Sleeved Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, true);
  assert.equal(result.rrpPence, 499);
  assert.equal(result.unitRrpPence, 499);
});

test("opened-live bundles fail closed because the service is not equivalent to sealed packs", () => {
  const result = resolveRrpValue({
    title: "Destined Rivals - 10 Pack Bundle — Opened Live On Stream",
    productType: "other",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, false);
});

test("official 3-pack blister RRP is never multiplied as if it were a single-pack reference", () => {
  const result = resolveRrpValue({
    title: "Destined Rivals - 10 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  }, buildRrpValueContext([products[2]]));
  assert.equal(result.resolved, false);
});

test("a loose single-pack retailer alias can expose a clearly-labelled set pack reference", () => {
  const result = resolveRrpValue({
    title: "Pokemon TCG: Destined Rivals - Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, true);
  assert.equal(result.kind, "pack_reference");
  assert.equal(result.rrpPence, 429);
  assert.match(result.rrpSource, /^reference:/);
});

test("conflicting verified loose-pack references fail closed", () => {
  const conflicting = buildRrpValueContext([
    products[0],
    { ...products[0], id: "other-loose-pack", officialRrpPence: 439, rrpSource: "other-authoritative-source" },
    products[1],
  ]);
  const result = resolveRrpValue({
    title: "Destined Rivals - 4 Pack Bundle — Sealed",
    productType: "other",
    tcg: "pokemon",
  }, conflicting);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "conflicting_verified_pack_reference");
});

test("explicit half booster box pack count can use the verified loose-pack component reference", () => {
  const result = resolveRrpValue({
    title: "Pokemon TCG: Destined Rivals - Half Booster Box (18 Packs)",
    productType: "booster_box",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, true);
  assert.equal(result.kind, "component_reference");
  assert.equal(result.rrpPence, 7722);
  assert.equal(result.unitCount, 18);
  assert.equal(result.unitRrpPence, 429);
  assert.equal(result.referenceBasis, "18 × verified booster-pack RRP");
});

test("explicit booster bundle pack count can use the verified loose-pack component reference", () => {
  const result = resolveRrpValue({
    title: "Pokemon TCG: Destined Rivals Booster Bundle (6 Packs)",
    productType: "booster_bundle",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, true);
  assert.equal(result.kind, "component_reference");
  assert.equal(result.rrpPence, 2574);
  assert.equal(result.unitCount, 6);
});

test("booster boxes without an explicit pack count remain unknown", () => {
  const result = resolveRrpValue({
    title: "Pokemon TCG: Destined Rivals Booster Box",
    productType: "booster_box",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, false);
});

test("ETBs remain excluded from pack-only component reference even when pack count is explicit", () => {
  const result = resolveRrpValue({
    title: "Pokemon TCG: Destined Rivals Elite Trainer Box (9 Packs)",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, context);
  assert.equal(result.resolved, false);
});
