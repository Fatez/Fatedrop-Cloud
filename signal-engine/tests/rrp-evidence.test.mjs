import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRrpEvidence } from "../src/core/rrp-evidence.mjs";

const observedAt = Date.UTC(2026, 7, 21);

test("accepts explicit manufacturer RRP evidence", () => {
  const result = evaluateRrpEvidence({
    title: "Pokemon Example Set Elite Trainer Box",
    sourceRole: "manufacturer",
    priceKind: "rrp",
    pricePence: 4999,
    currency: "GBP",
    sourceName: "Official manufacturer",
    sourceUrl: "https://www.pokemon.com/uk/example-product",
    observedAt,
  });
  assert.equal(result.decision, "eligible");
  assert.equal(result.eligibleForOfficialRrp, true);
  assert.equal(result.officialRrpPence, 4999);
});

test("accepts explicit distributor RRP evidence", () => {
  const result = evaluateRrpEvidence({
    title: "Pokemon Example Set Booster Box",
    sourceRole: "authorized_distributor",
    priceKind: "rrp",
    pricePence: 14364,
    currency: "GBP",
    sourceName: "Authorized distributor",
    sourceUrl: "https://distributor.example.com/pokemon/example",
    observedAt,
  });
  assert.equal(result.decision, "eligible");
  assert.equal(result.officialRrpPence, 14364);
});

test("official Pokemon Center selling price remains reference-only when not labelled RRP", () => {
  const result = evaluateRrpEvidence({
    title: "Pokemon TCG: Sword & Shield-Silver Tempest Elite Trainer Box",
    sourceRole: "official_store",
    priceKind: "official_store_price",
    pricePence: 3999,
    currency: "GBP",
    sourceName: "Pokemon Center UK",
    sourceUrl: "https://www.pokemoncenter.com/en-gb/search/mawile",
    observedAt,
  });
  assert.equal(result.decision, "reference_only");
  assert.equal(result.eligibleForOfficialRrp, false);
  assert.equal(result.officialRrpPence, null);
  assert.ok(result.reasons.includes("official_store_selling_price_is_not_explicit_rrp"));
});

test("retailer claimed RRP cannot establish official RRP", () => {
  const result = evaluateRrpEvidence({
    title: "Pokemon Example Set Elite Trainer Box",
    sourceRole: "retailer",
    priceKind: "rrp",
    pricePence: 4999,
    currency: "GBP",
    sourceName: "Example retailer",
    sourceUrl: "https://retailer.example.com/product",
    observedAt,
  });
  assert.equal(result.decision, "reject");
  assert.equal(result.eligibleForOfficialRrp, false);
});

test("retailer was-price is rejected", () => {
  const result = evaluateRrpEvidence({
    title: "Pokemon Example Set Elite Trainer Box",
    sourceRole: "retailer",
    priceKind: "was_price",
    pricePence: 6999,
    currency: "GBP",
    sourceName: "Example retailer",
    sourceUrl: "https://retailer.example.com/product",
    observedAt,
  });
  assert.equal(result.decision, "reject");
  assert.match(result.reasons[0], /^retailer_was_price/);
});

test("foreign currency cannot establish UK RRP", () => {
  const result = evaluateRrpEvidence({
    title: "Pokemon Example Set Elite Trainer Box",
    sourceRole: "manufacturer",
    priceKind: "msrp",
    pricePence: 5999,
    currency: "USD",
    sourceName: "Official manufacturer",
    sourceUrl: "https://www.pokemon.com/us/example-product",
    observedAt,
  });
  assert.equal(result.decision, "reject");
  assert.deepEqual(result.reasons, ["foreign_currency_for_uk_rrp:USD"]);
});

test("evidence without durable provenance is rejected", () => {
  const result = evaluateRrpEvidence({
    title: "Pokemon Example Set Elite Trainer Box",
    sourceRole: "manufacturer",
    priceKind: "rrp",
    pricePence: 4999,
    currency: "GBP",
    sourceUrl: "http://insecure.example.com/product",
  });
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.includes("invalid_or_non_https_source_url"));
  assert.ok(result.reasons.includes("missing_observed_at"));
});
