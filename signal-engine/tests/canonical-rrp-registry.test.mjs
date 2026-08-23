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
    title: "Phantasmal Flames Elite Trainer Box",
    productType: "elite_trainer_box",
    tcg: "pokemon",
  }, registry);
  const exclusive = resolveCanonicalRrp({
    title: "Pokemon Center Phantasmal Flames Elite Trainer Box",
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
