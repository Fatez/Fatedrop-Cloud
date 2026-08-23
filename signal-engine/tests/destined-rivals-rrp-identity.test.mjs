import test from "node:test";
import assert from "node:assert/strict";
import { compareProductIdentity, describeProductIdentity } from "../src/core/product-identity.mjs";
import { chooseCanonicalMatch } from "../src/rrp/asmodee-authority.mjs";

test("10 Cards packaging text is not mistaken for the Scarlet & Violet 10 set number", () => {
  const setNumber = describeProductIdentity("Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack");
  const packContents = describeProductIdentity("Pokemon TCG: Scarlet & Violet-Destined Rivals Booster Pack (10 Cards)");

  assert.match(setNumber.core, /\b10\b/);
  assert.doesNotMatch(packContents.core, /\b10\b/);
  assert.notEqual(setNumber.coreSignature, packContents.coreSignature);
});

test("sleeved booster is a separate format variant from a loose booster", () => {
  const result = compareProductIdentity(
    "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
    "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Sleeved Booster Pack (10 Cards)",
  );

  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^format_variant_conflict:/);
});

test("Asmodee Destined Rivals CDU unit RRP resolves to the loose SV10 booster only", () => {
  const products = [
    {
      id: "loose-sv10",
      title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
      product_type: "booster_pack",
      tcg: "pokemon",
    },
    {
      id: "packaging-count-alias",
      title: "Pokemon TCG: Scarlet & Violet-Destined Rivals Booster Pack (10 Cards)",
      product_type: "booster_pack",
      tcg: "pokemon",
    },
    {
      id: "sleeved-sv10",
      title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Sleeved Booster Pack (10 Cards)",
      product_type: "booster_pack",
      tcg: "pokemon",
    },
  ];

  const match = chooseCanonicalMatch({
    title: "Pokémon TCG: Scarlet & Violet 10 - Destined Rivals - Booster Display CDU",
    barcode: null,
    rrpUnitCount: 36,
  }, products, new Map());

  assert.equal(match?.method, "identity");
  assert.equal(match?.product?.id, "loose-sv10");
});
