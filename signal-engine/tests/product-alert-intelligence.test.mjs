import assert from "node:assert/strict";
import test from "node:test";
import { classifyProductAlert } from "../src/core/product-alert-intelligence.mjs";

test("classifies obvious merchandise and accessories away from collector TCG products", () => {
  assert.equal(classifyProductAlert({ title: "Hariyama Pokémon Pin", productType: "other" }).category, "MERCHANDISE");
  assert.equal(classifyProductAlert({ title: "Pokémon Card Sleeves", productType: "accessory" }).category, "ACCESSORY");
});

test("keeps sealed products even when their bundle includes an accessory", () => {
  const result = classifyProductAlert({ title: "Pokémon TCG Special Collection - Pin & 4 Booster Packs", productType: "collection_box" });
  assert.equal(result.category, "SEALED_TCG");
  assert.equal(result.subcategory, "COLLECTION");
  assert.ok(result.confidence >= 0.9);
});

test("recognises sealed, single-card and unknown listings independently", () => {
  assert.equal(classifyProductAlert({ title: "Scarlet & Violet Elite Trainer Box", productType: "elite_trainer_box" }).category, "SEALED_TCG");
  assert.equal(classifyProductAlert({ title: "Pikachu Promo Card", productType: "other" }).category, "SINGLE_CARD");
  assert.equal(classifyProductAlert({ title: "Mystery Pokémon Item", productType: "other" }).category, "UNKNOWN");
});
