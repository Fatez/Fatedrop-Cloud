import test from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalRrpRegistry, resolveCanonicalRrp } from "../src/core/canonical-rrp-registry.mjs";

const verified = [
  {
    id: "prd-etb",
    title: "Pokémon TCG: Mega Evolution—Phantasmal Flames Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
    officialRrpPence: 4999,
    rrpSource: "asmodee-uk",
    rrpObservedAt: 1_700_000_000,
  },
  {
    id: "prd-pc-etb",
    title: "Pokémon Center Mega Evolution Phantasmal Flames Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
    officialRrpPence: 5999,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_700_000_100,
  },
  {
    id: "prd-pack",
    title: "Pokémon TCG: Mega Evolution—Phantasmal Flames Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 429,
    rrpSource: "asmodee-uk",
    rrpObservedAt: 1_700_000_200,
  },
];

test("verified RRP survives retailer ETB abbreviation", () => {
  const registry = buildCanonicalRrpRegistry(verified);
  const result = resolveCanonicalRrp({
    title: "Pokemon TCG Mega Evolution Phantasmal Flames ETB",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, true);
  assert.equal(result.officialRrpPence, 4999);
  assert.equal(result.rrpSource, "asmodee-uk");
});

test("Pokemon Center exclusive RRP is not inherited by a standard ETB", () => {
  const registry = buildCanonicalRrpRegistry(verified);
  const standard = resolveCanonicalRrp({
    title: "Mega Evolution Phantasmal Flames Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  const exclusive = resolveCanonicalRrp({
    title: "Pokemon Center Mega Evolution Phantasmal Flames Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(standard.resolved, true);
  assert.equal(standard.officialRrpPence, 4999);
  assert.equal(exclusive.resolved, true);
  assert.equal(exclusive.officialRrpPence, 5999);
});

test("booster pack RRP cannot leak into a booster box", () => {
  const registry = buildCanonicalRrpRegistry(verified);
  const result = resolveCanonicalRrp({
    title: "Phantasmal Flames Booster Box",
    productType: "booster_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "no_authoritative_candidate");
});

test("conflicting verified prices fail closed rather than choosing one", () => {
  const registry = buildCanonicalRrpRegistry([
    verified[0],
    { ...verified[0], id: "prd-etb-conflict", officialRrpPence: 5499, rrpSource: "other-authority" },
  ]);
  const result = resolveCanonicalRrp({
    title: "Pokemon Mega Evolution Phantasmal Flames ETB",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "conflicting_verified_rrp");
  assert.deepEqual(result.prices.sort((a, b) => a - b), [4999, 5499]);
});

test("retailer prices without verified RRP provenance never enter the registry", () => {
  const registry = buildCanonicalRrpRegistry([
    { id: "retailer-only", title: "Phantasmal Flames ETB", productType: "elite_trainer_box", tcg: "pokemon", officialRrpPence: 6999, rrpSource: "" },
  ]);
  assert.equal(registry.authoritativeProducts, 0);
});

test("Scarlet & Violet sequence numbers do not block an otherwise exact verified RRP", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "destined-pack",
    title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 429,
    rrpSource: "asmodee-uk",
    rrpObservedAt: 1_700_000_300,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon - Scarlet & Violet - Destined Rivals - Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, true);
  assert.equal(result.officialRrpPence, 429);
  assert.deepEqual(result.matchedProductIds, ["destined-pack"]);
});

test("SV retailer shorthand and official Scarlet & Violet set sequence resolve to one ETB identity", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "prismatic-etb",
    title: "Pokemon TCG: Scarlet & Violet 8.5 - Prismatic Evolutions Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
    officialRrpPence: 4999,
    rrpSource: "asmodee-uk",
    rrpObservedAt: 1_700_000_400,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon TCG: SV Prismatic Evolutions Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, true);
  assert.equal(result.officialRrpPence, 4999);
  assert.deepEqual(result.matchedProductIds, ["prismatic-etb"]);
});

test("Sword & Shield era prefix can be omitted when a named expansion remains", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "brilliant-stars-etb",
    title: "Pokemon SWSH Brilliant Stars Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
    officialRrpPence: 3799,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_700_000_500,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon Brilliant Stars Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, true);
  assert.equal(result.officialRrpPence, 3799);
  assert.deepEqual(result.matchedProductIds, ["brilliant-stars-etb"]);
});

test("base Sword & Shield set identity is never erased into a generic ETB", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "swsh-base-etb",
    title: "Pokemon Sword & Shield Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
    officialRrpPence: 3799,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_700_000_600,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, false);
});

test("base Scarlet & Violet set identity is never erased into a generic ETB", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "sv-base-etb",
    title: "Pokemon Scarlet & Violet Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
    officialRrpPence: 4999,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_700_000_700,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, false);
});

test("retailer CDU suffix does not create a different booster-box RRP identity", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "obsidian-box",
    title: "Pokemon TCG: Scarlet & Violet 3 - Obsidian Flames Booster Box",
    productType: "booster_box",
    tcg: "pokemon",
    officialRrpPence: 15199,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_700_000_800,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon TCG: Scarlet & Violet 3 Obsidian Flames Booster Box - CDU",
    productType: "booster_box",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, true);
  assert.equal(result.officialRrpPence, 15199);
});

test("trailing V on an explicit V Battle Deck is treated as redundant retailer wording", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "melmetal-deck",
    title: "Pokemon - Pokemon Go - V Battle Deck - Melmetal",
    productType: "deck",
    tcg: "pokemon",
    officialRrpPence: 1499,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_700_000_900,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon - Pokemon Go - V Battle Deck - Melmetal V",
    productType: "deck",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, true);
  assert.equal(result.officialRrpPence, 1499);
});

test("V suffix cleanup is not applied to unrelated deck products", () => {
  const registry = buildCanonicalRrpRegistry([{
    id: "pikachu-deck",
    title: "Pokemon Pikachu Battle Deck",
    productType: "deck",
    tcg: "pokemon",
    officialRrpPence: 1499,
    rrpSource: "pokemon-center-uk",
    rrpObservedAt: 1_700_001_000,
  }]);
  const result = resolveCanonicalRrp({
    title: "Pokemon Pikachu V Battle Deck",
    productType: "deck",
    tcg: "pokemon",
  }, registry);
  assert.equal(result.resolved, false);
});
