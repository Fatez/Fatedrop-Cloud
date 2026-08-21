import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAsmodeePokemonRrpRecord } from "../src/core/asmodee-rrp-source.mjs";

const observedAt = Date.UTC(2026, 7, 21);

test("normalizes source-backed Twilight Masquerade RRP with barcode", () => {
  const result = normalizeAsmodeePokemonRrpRecord({
    title: "Pokémon TCG: Scarlet & Violet 6 - Twilight Masquerade - Elite Trainer Box",
    publisher: "The Pokémon Company Int. Inc.",
    sku: "POK87798",
    barcode: "820650857980",
    rrpPence: 4999,
    sourceUrl: "https://www.asmodee.co.uk/products/pok87798-pokemon-tcg-scarlet-violet-6-twilight-masquerade-elite-trainer-box",
    observedAt,
  });
  assert.equal(result.decision, "eligible");
  assert.equal(result.evidence.pricePence, 4999);
  assert.equal(result.evidence.identifiers.barcode, "820650857980");
  assert.equal(result.evidence.identifiers.distributor_sku, "POK87798");
});

test("normalizes source-backed Prismatic Evolutions RRP", () => {
  const result = normalizeAsmodeePokemonRrpRecord({
    title: "Pokémon TCG: Scarlet & Violet 8.5 - Prismatic Evolutions - Elite Trainer Box",
    publisher: "The Pokémon Company Int. Inc.",
    sku: "POK10010013",
    barcode: "0196214105133",
    rrpPence: 4999,
    sourceUrl: "https://www.asmodee.co.uk/products/pok10010013-pokemon-tcg-scarlet-violet-8-5-prismatic-evolutions-elite-trainer-box",
    observedAt,
  });
  assert.equal(result.decision, "eligible");
  assert.equal(result.evidence.pricePence, 4999);
});

test("normalizes source-backed Charizard ex Super-Premium Collection RRP", () => {
  const result = normalizeAsmodeePokemonRrpRecord({
    title: "Pokémon TCG: Charizard ex Super-Premium Collection",
    publisher: "The Pokémon Company Int. Inc.",
    sku: "POK1010001101",
    barcode: "0196214112001",
    rrpPence: 7999,
    sourceUrl: "https://www.asmodee.co.uk/products/pok1010001101-pokemon-tcg-charizard-ex-super-premium-collection",
    observedAt,
  });
  assert.equal(result.decision, "eligible");
  assert.equal(result.evidence.pricePence, 7999);
});

test("removes distributor unit suffix without weakening product identity", () => {
  const result = normalizeAsmodeePokemonRrpRecord({
    title: "Pokémon TCG: Mega Evolution Perfect Order - Elite Trainer Box (1)",
    publisher: "The Pokémon Company Int. Inc.",
    sku: "POK1010372111",
    barcode: "0196214152038",
    rrpPence: 4999,
    sourceUrl: "https://www.asmodee.co.uk/products/pok1010372111-pokemon-tcg-mega-evolution-perfect-order-elite-trainer-box-1",
    observedAt,
  });
  assert.equal(result.decision, "eligible");
  assert.equal(result.evidence.title.endsWith("(1)"), false);
});

test("rejects zero RRP even from Asmodee", () => {
  const result = normalizeAsmodeePokemonRrpRecord({
    title: "Pokémon TCG: Example Case",
    publisher: "The Pokémon Company Int. Inc.",
    sku: "POKZERO",
    barcode: "0196214000000",
    rrpPence: 0,
    sourceUrl: "https://www.asmodee.co.uk/products/example-case",
    observedAt,
  });
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.includes("invalid_rrp"));
});

test("rejects non-Pokemon publisher records", () => {
  const result = normalizeAsmodeePokemonRrpRecord({
    title: "Some Other Trading Card Game",
    publisher: "Other Publisher",
    sku: "OTHER1",
    barcode: "1234567890123",
    rrpPence: 4999,
    sourceUrl: "https://www.asmodee.co.uk/products/other-product",
    observedAt,
  });
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.includes("publisher_not_pokemon_company"));
});
