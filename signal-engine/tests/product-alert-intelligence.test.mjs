import assert from "node:assert/strict";
import test from "node:test";
import { classifyProductAlert, isBetaAlertEligible } from "../src/core/product-alert-intelligence.mjs";

test("classifies obvious merchandise and accessories away from collector TCG products", () => {
  assert.equal(classifyProductAlert({ title: "Hariyama Pokémon Pin", productType: "other" }).category, "MERCHANDISE");
  assert.equal(classifyProductAlert({ title: "Pokemon TCG: Mini Portfolio - Q1 2026", productType: "accessory" }).category, "ACCESSORY");
  assert.equal(classifyProductAlert({ title: "Pokémon Card Sleeves", productType: "accessory" }).category, "ACCESSORY");
});

test("collection-box metadata cannot promote obvious merchandise into sealed TCG alerts", () => {
  const cases = [
    ["Pokemon - Sleeping Eevee - Blind Box", "BLIND_BOX"],
    ["Pokemon - Shining Debut - 3D Fridge Magnet - Blind Box", "BLIND_BOX"],
    ["Dragon Type Pokémon Fundamentals Fold-Over Backpack", "BAG"],
    ["Pokémon Center × Van Gogh Museum: Pokémon Inspired by Paintings Journal", "STATIONERY"],
  ];
  for (const [title, subcategory] of cases) {
    const result = classifyProductAlert({ title, productType: "collection_box" });
    assert.equal(result.category, "MERCHANDISE", title);
    assert.equal(result.subcategory, subcategory, title);
    assert.equal(isBetaAlertEligible({ title, productType: "collection_box" }), false, title);
  }
});

test("keeps sealed products even when their bundle includes an accessory", () => {
  const result = classifyProductAlert({ title: "Pokémon TCG Special Collection - Pin & 4 Booster Packs", productType: "collection_box" });
  assert.equal(result.category, "SEALED_TCG");
  assert.equal(result.subcategory, "COLLECTION");
  assert.ok(result.confidence >= 0.9);
});

test("keeps real sealed collection formats despite words also used by accessories or merchandise", () => {
  const cases = [
    "Pokémon TCG: Scarlet & Violet-151 Binder Collection",
    "Pokémon TCG: Scarlet & Violet-Prismatic Evolutions Poster Collection",
    "Pokémon TCG: Scarlet & Violet-Prismatic Evolutions Tech Sticker Collection",
    "Pokémon TCG: Crown Zenith Premium Figure Collection",
    "Pokémon TCG: Sword & Shield-Lost Origin Sleeved Booster Pack (10 Cards)",
  ];
  for (const title of cases) {
    assert.equal(classifyProductAlert({ title, productType: "collection_box" }).category, "SEALED_TCG", title);
  }
});

test("recognises sealed, single-card and unknown listings independently", () => {
  assert.equal(classifyProductAlert({ title: "Scarlet & Violet Elite Trainer Box", productType: "elite_trainer_box" }).category, "SEALED_TCG");
  assert.equal(classifyProductAlert({ title: "Shaymin EX RC21/RC25 - Light Play (LP)", productType: "other" }).category, "SINGLE_CARD");
  assert.equal(classifyProductAlert({ title: "Mystery Pokémon Item", productType: "other" }).category, "UNKNOWN");
});

test("beta delivery is sealed-TCG only while raw monitoring can retain everything else", () => {
  assert.equal(isBetaAlertEligible({ title: "Mega Charizard Y ex Tin", productType: "tin" }), true);
  assert.equal(isBetaAlertEligible({ title: "Pokemon Mini Portfolio", productType: "accessory" }), false);
  assert.equal(isBetaAlertEligible({ title: "Pikachu Promo Card", productType: "single_card" }), false);
  assert.equal(isBetaAlertEligible({ title: "Pokemon Plush", productType: "other" }), false);
});
