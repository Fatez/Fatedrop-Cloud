import test from "node:test";
import assert from "node:assert/strict";
import { canonicalKey, parseMoneyToPence, productTypeFromTitle } from "../src/core/normalize.mjs";

test("normalises retailer naming into a stable canonical key", () => {
  assert.equal(canonicalKey("Pokémon TCG: Mega Evolution Elite Trainer Box", "elite_trainer_box"), "elite_trainer_box:mega evolution elite trainer box");
});
test("parses GBP prices", () => { assert.equal(parseMoneyToPence("£49.99"), 4999); assert.equal(parseMoneyToPence("RRP £154.44"), 15444); });
test("classifies common sealed products", () => { assert.equal(productTypeFromTitle("Pokemon Mega Evolution Booster Box (36 Packs)"), "booster_box"); assert.equal(productTypeFromTitle("Pokémon 30th Celebration Elite Trainer Box"), "elite_trainer_box"); });
