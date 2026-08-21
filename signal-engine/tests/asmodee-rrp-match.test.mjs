import test from "node:test";
import assert from "node:assert/strict";
import { chooseCanonicalMatch, parseAsmodeeProductPage } from "../src/rrp/asmodee-authority.mjs";

const products = [
  {
    id: "prd_etb",
    title: "Pokemon TCG: Scarlet & Violet 6 - Twilight Masquerade Elite Trainer Box",
    product_type: "elite_trainer_box",
    tcg: "pokemon",
  },
  {
    id: "prd_etb_case",
    title: "Pokemon TCG: Scarlet & Violet 6 - Twilight Masquerade Elite Trainer Box Case (10 Units)",
    product_type: "elite_trainer_box",
    tcg: "pokemon",
  },
  {
    id: "prd_pack",
    title: "Pokemon TCG Mega Evolution Phantasmal Flames Booster Pack",
    product_type: "booster_pack",
    tcg: "pokemon",
  },
  {
    id: "prd_box",
    title: "Pokemon TCG Mega Evolution Phantasmal Flames Booster Box",
    product_type: "booster_box",
    tcg: "pokemon",
  },
  {
    id: "prd_bundle",
    title: "Pokemon TCG Mega Evolution Phantasmal Flames Booster Bundle",
    product_type: "booster_bundle",
    tcg: "pokemon",
  },
];

test("matches Asmodee ETB to the precise FateDrop product type", () => {
  const match = chooseCanonicalMatch({
    title: "Pokémon TCG: Scarlet & Violet 6 - Twilight Masquerade - Elite Trainer Box",
    barcode: null,
  }, products, new Map());

  assert.equal(match?.method, "identity");
  assert.equal(match?.product?.id, "prd_etb");
});

test("removes Asmodee single-unit suffix without matching a case", () => {
  const match = chooseCanonicalMatch({
    title: "Pokémon TCG: Scarlet & Violet 6 - Twilight Masquerade - Elite Trainer Box (1)",
    barcode: null,
  }, products, new Map());

  assert.equal(match?.method, "identity");
  assert.equal(match?.product?.id, "prd_etb");
});

test("parses Asmodee per-unit CDU RRP", () => {
  const html = `<!doctype html><html><body>
    <h1>Pokémon TCG: Mega Evolution Phantasmal Flames - Booster Display CDU</h1>
    <div>The Pokémon Company Int. Inc. | Product Code (SKU): POK1010190119 | Barcode: 0196214143357</div>
    <div>RRP: 36 units at £4.29</div>
    <div>Publisher: The Pokémon Company Int. Inc. Subcategory: Trading Card Games Family: Pokémon</div>
  </body></html>`;
  const result = parseAsmodeeProductPage(html, "https://www.asmodee.co.uk/products/test");

  assert.equal(result.officialRrpPence, 429);
  assert.equal(result.rrpUnitCount, 36);
});

test("maps Asmodee Booster Display CDU unit RRP to a booster pack, not a booster box", () => {
  const match = chooseCanonicalMatch({
    title: "Pokémon TCG: Mega Evolution Phantasmal Flames - Booster Display CDU",
    barcode: null,
    rrpUnitCount: 36,
  }, products, new Map());

  assert.equal(match?.method, "identity");
  assert.equal(match?.product?.id, "prd_pack");
});

test("maps Asmodee Booster CDU unit RRP to a booster pack", () => {
  const match = chooseCanonicalMatch({
    title: "Pokémon TCG: Mega Evolution Phantasmal Flames - Booster CDU",
    barcode: null,
    rrpUnitCount: 36,
  }, products, new Map());

  assert.equal(match?.method, "identity");
  assert.equal(match?.product?.id, "prd_pack");
});

test("removes matching distributor case quantity and CDU suffix for booster bundles", () => {
  const match = chooseCanonicalMatch({
    title: "Pokémon TCG: Mega Evolution Phantasmal Flames - Booster Bundle CDU (25)",
    barcode: null,
    rrpUnitCount: 25,
  }, products, new Map());

  assert.equal(match?.method, "identity");
  assert.equal(match?.product?.id, "prd_bundle");
});

test("does not rewrite CDU titles without explicit multi-unit RRP evidence", () => {
  const match = chooseCanonicalMatch({
    title: "Pokémon TCG: Mega Evolution Phantasmal Flames - Booster Display CDU",
    barcode: null,
    rrpUnitCount: null,
  }, products, new Map());

  assert.equal(match, null);
});
