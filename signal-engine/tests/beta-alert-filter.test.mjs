import assert from "node:assert/strict";
import test from "node:test";
import { deriveSignal } from "../src/core/signals.mjs";

function offer(title, productType, status = "coming_soon", extra = {}) {
  return {
    offerId: `off_${productType}`,
    productId: `prd_${productType}`,
    retailerId: "eterna-cards",
    retailerName: "Eterna Cards",
    retailerSku: `SKU-${productType}`,
    title,
    productType,
    url: "https://example.test/product",
    pricePence: 1999,
    rrpPence: null,
    postagePence: null,
    stockStatus: status,
    stockConfidence: 0.99,
    evidence: [],
    everAvailableAt: null,
    lastSeenAt: null,
    ...extra,
  };
}

test("accessories stay observable but never become beta lifecycle alerts", () => {
  assert.equal(deriveSignal({ previousOffer: null, currentOffer: offer("Pokemon TCG: Mini Portfolio - Q1 2026", "accessory"), now: 100 }), null);
});

test("single cards stay out of the beta lifecycle stream", () => {
  assert.equal(deriveSignal({ previousOffer: null, currentOffer: offer("Shaymin EX RC21/RC25 - Light Play (LP)", "other", "in_stock"), now: 100 }), null);
});

test("sealed collections remain eligible even when the title contains a pin", () => {
  const signal = deriveSignal({ previousOffer: null, currentOffer: offer("Pokemon TCG Special Collection - Pin & 4 Booster Packs", "collection_box"), now: 100 });
  assert.equal(signal?.state, "whisper");
  assert.equal(signal?.productCategory, "SEALED_TCG");
  assert.equal(signal?.productSubcategory, "COLLECTION");
  assert.equal(signal?.evidence?.some((entry) => entry.kind === "product_alert_category" && entry.value === "SEALED_TCG"), true);
});
