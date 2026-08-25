import test from "node:test";
import assert from "node:assert/strict";
import { deriveSignal } from "../src/core/signals.mjs";

function offer(stockStatus, extra = {}) {
  return {
    offerId: "off-mega-dream-jp",
    productId: "prd-mega-dream-jp",
    retailerId: "card-collective-uk",
    retailerName: "Card Collective UK",
    retailerSku: "58025087205757",
    title: "Mega Dream - Japanese Booster Pack — Sealed",
    productType: "booster_pack",
    url: "https://example.test/mega-dream-jp",
    imageUrl: null,
    pricePence: 1695,
    rrpPence: null,
    postagePence: null,
    stockStatus,
    stockConfidence: 0.98,
    evidence: [],
    everAvailableAt: null,
    lastSeenAt: null,
    ...extra,
  };
}

function evidenceValue(signal, kind) {
  return signal?.evidence?.find((entry) => entry?.kind === kind)?.value ?? null;
}

test("Japanese Manifested signal carries the verified source-market MSRP reference", () => {
  const signal = deriveSignal({
    previousOffer: offer("out_of_stock", { everAvailableAt: 100 }),
    currentOffer: offer("in_stock", { everAvailableAt: 100 }),
    now: 200,
  });

  assert.equal(signal?.state, "manifested");
  assert.equal(signal?.kind, "restock");
  assert.equal(signal?.rrpPence, 253);
  assert.ok(Number.isFinite(signal?.markupPercent));
  assert.equal(evidenceValue(signal, "rrp_value_kind"), "source_market_msrp");
  assert.equal(evidenceValue(signal, "rrp_source_market"), "JP");
  assert.equal(evidenceValue(signal, "rrp_source_currency"), "JPY");
  assert.equal(evidenceValue(signal, "rrp_source_msrp"), "550");
  assert.match(evidenceValue(signal, "rrp_reference_basis") || "", /Official Japan MSRP ¥550 per booster pack/);
});

test("recognized import without verified source MSRP does not inherit a UK RRP", () => {
  const signal = deriveSignal({
    previousOffer: offer("out_of_stock", { title: "Unmapped Set - Japanese Booster Pack — Sealed" }),
    currentOffer: offer("in_stock", { title: "Unmapped Set - Japanese Booster Pack — Sealed" }),
    now: 201,
  });
  assert.equal(signal?.rrpPence, null);
  assert.equal(evidenceValue(signal, "rrp_value_kind"), null);
});
