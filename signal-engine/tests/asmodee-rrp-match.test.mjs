import test from "node:test";
import assert from "node:assert/strict";
import { chooseCanonicalMatch } from "../src/rrp/asmodee-authority.mjs";

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
