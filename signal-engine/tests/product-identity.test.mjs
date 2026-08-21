import test from "node:test";
import assert from "node:assert/strict";
import { compareProductIdentity, describeProductIdentity } from "../src/core/product-identity.mjs";

test("matches equivalent standard ETB titles after deterministic normalization", () => {
  const result = compareProductIdentity(
    "Pokémon TCG: Scarlet & Violet—151 Elite Trainer Box",
    "Pokemon Scarlet and Violet 151 ETB",
  );
  assert.equal(result.decision, "match");
  assert.equal(result.left.productType, "elite_trainer_box");
  assert.equal(result.left.coreSignature, result.right.coreSignature);
});

test("rejects Pokemon Center ETB against standard ETB", () => {
  const result = compareProductIdentity(
    "Pokemon Center Scarlet & Violet 151 Elite Trainer Box",
    "Pokemon Scarlet & Violet 151 Elite Trainer Box",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^exclusive_conflict:/);
});

test("rejects booster box against booster bundle", () => {
  const result = compareProductIdentity(
    "Pokemon Destined Rivals Booster Box",
    "Pokemon Destined Rivals Booster Bundle",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^product_type_conflict:/);
});

test("rejects conflicting explicit languages", () => {
  const result = compareProductIdentity(
    "Pokemon 151 Booster Box Japanese",
    "Pokemon 151 Booster Box English",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^language_conflict:/);
});

test("rejects single booster box against sealed case", () => {
  const result = compareProductIdentity(
    "Pokemon Surging Sparks Booster Box",
    "Pokemon Surging Sparks Booster Box Sealed Case",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^unit_kind_conflict:/);
});

test("rejects conflicting explicit pack counts", () => {
  const result = compareProductIdentity(
    "Pokemon Example Set Booster Box 36 Packs",
    "Pokemon Example Set Booster Box 18 Packs",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^pack_count_conflict:/);
});

test("reports ambiguity when a critical quantity exists on only one side", () => {
  const result = compareProductIdentity(
    "Pokemon Example Set Booster Box 36 Packs",
    "Pokemon Example Set Booster Box",
  );
  assert.equal(result.decision, "ambiguous");
  assert.ok(result.reasons.includes("pack_count_missing_on_one_side"));
});

test("rejects conflicting regions when both are explicit", () => {
  const result = compareProductIdentity(
    "Pokemon Example Set Elite Trainer Box UK",
    "Pokemon Example Set Elite Trainer Box US",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^region_conflict:/);
});

test("rejects first edition against unlimited edition", () => {
  const result = compareProductIdentity(
    "Pokemon Base Set Booster Box 1st Edition",
    "Pokemon Base Set Booster Box Unlimited Edition",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^edition_conflict:/);
});

test("shared identifiers cannot override a critical variant conflict", () => {
  const result = compareProductIdentity(
    { title: "Pokemon Center Example Set Elite Trainer Box", identifiers: { gtin: "123456" } },
    { title: "Pokemon Example Set Elite Trainer Box", identifiers: { gtin: "123456" } },
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons.at(-1), /^exclusive_conflict:/);
});

test("conflicting shared identifiers are rejected", () => {
  const result = compareProductIdentity(
    { title: "Pokemon Example Set Booster Box", identifiers: { gtin: "111" } },
    { title: "Pokemon Example Set Booster Box", identifiers: { gtin: "222" } },
  );
  assert.equal(result.decision, "reject");
  assert.deepEqual(result.reasons, ["identifier_conflict:gtin"]);
});

test("descriptor preserves explicit identifier and variant dimensions", () => {
  const descriptor = describeProductIdentity({
    title: "Pokemon Center Example Set Elite Trainer Box English UK",
    identifiers: { UPC: " 0123456789 " },
  });
  assert.equal(descriptor.exclusive, "pokemon_center");
  assert.equal(descriptor.language, "english");
  assert.equal(descriptor.region, "uk");
  assert.equal(descriptor.identifiers.upc, "0123456789");
});

test("rejects half booster box against full booster box from real retailer naming", () => {
  const result = compareProductIdentity(
    "Pokemon TCG: Scarlet & Violet 9 – Journey Together Half Booster Box",
    "Pokemon - Scarlet & Violet - Journey Together - Booster Box (36 Boosters)",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^format_variant_conflict:/);
});

test("rejects enhanced booster box against standard booster box", () => {
  const result = compareProductIdentity(
    "Pokemon - Scarlet & Violet - Journey Together - ENHANCED Booster Box (36 Boosters)",
    "Pokemon - Scarlet & Violet - Journey Together - Booster Box (36 Boosters)",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^format_variant_conflict:/);
});

test("rejects opened-live product against sealed presentation", () => {
  const result = compareProductIdentity(
    "MEGA Dream EX - Japanese Booster Box — Opened Live On Stream",
    "MEGA Dream EX - Japanese Booster Box — Sealed",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^presentation_conflict:/);
});

test("rejects slim booster box against jumbo booster box", () => {
  const result = compareProductIdentity(
    "Collect 151 Hope - Simplified Chinese Slim Booster Box — Sealed",
    "Collect 151 Hope - Simplified Chinese Jumbo Booster Box — Sealed",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^format_variant_conflict:/);
});

test("extracts case quantity from real case-title style", () => {
  const descriptor = describeProductIdentity(
    "Pokemon - Scarlet & Violet - Temporal Forces - Booster Box Case (6 Booster Boxes)",
  );
  assert.equal(descriptor.unitKind, "case");
  assert.equal(descriptor.caseQuantity, 6);
});

test("distinguishes case sizes for the same product", () => {
  const result = compareProductIdentity(
    "Pokemon Example Set Booster Box Case (6 Booster Boxes)",
    "Pokemon Example Set Booster Box Case (10 Booster Boxes)",
  );
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^case_quantity_conflict:/);
});
