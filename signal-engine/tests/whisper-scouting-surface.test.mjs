import assert from "node:assert/strict";
import test from "node:test";

import { deriveSignal } from "../src/core/signals.mjs";

function offer(extra = {}) {
  return {
    offerId: "off_test_whisper",
    productId: "prd_test_whisper",
    retailerId: "test-retailer",
    retailerName: "Test Retailer",
    retailerSku: "SKU-001",
    title: "Pokemon Scarlet & Violet Booster Box",
    productType: "sealed",
    url: "https://example.com/pokemon-booster-box",
    imageUrl: null,
    pricePence: null,
    rrpPence: null,
    postagePence: null,
    stockStatus: "unknown",
    stockConfidence: 0.5,
    stockQuantity: null,
    evidence: [{ kind: "structured_catalogue", value: "present" }],
    everAvailableAt: null,
    firstSeenAt: 100,
    lastSeenAt: 100,
    ...extra,
  };
}

test("new exact sealed TCG SKU on a structured retailer surface can Whisper while stock remains unknown", () => {
  const signal = deriveSignal({ previousOffer: null, currentOffer: offer(), now: 200 });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.kind, "catalogue_new");
  assert.equal(signal.stockStatus, "unknown");
});

test("unknown listing without exact identity does not surface as Whisper", () => {
  const signal = deriveSignal({
    previousOffer: null,
    currentOffer: offer({ retailerSku: null }),
    now: 200,
  });
  assert.equal(signal, null);
});

test("unknown listing without a structured or official scouting surface does not surface as Whisper", () => {
  const signal = deriveSignal({
    previousOffer: null,
    currentOffer: offer({ evidence: [{ kind: "page_text", value: "pokemon" }] }),
    now: 200,
  });
  assert.equal(signal, null);
});

test("new meaningful preparation evidence on an existing non-live SKU surfaces one Whisper", () => {
  const previous = offer({ lastSeenAt: 150 });
  const current = offer({
    lastSeenAt: 200,
    evidence: [
      { kind: "structured_catalogue", value: "present" },
      { kind: "inventory_metadata", value: "exposed" },
    ],
  });
  const signal = deriveSignal({ previousOffer: previous, currentOffer: current, now: 200 });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.kind, "product_evidence_change");
});

test("unchanged preparation evidence does not repeat Whisper", () => {
  const evidence = [
    { kind: "structured_catalogue", value: "present" },
    { kind: "inventory_metadata", value: "exposed" },
  ];
  const previous = offer({ lastSeenAt: 150, evidence });
  const current = offer({ lastSeenAt: 200, evidence });
  const signal = deriveSignal({ previousOffer: previous, currentOffer: current, now: 200 });
  assert.equal(signal, null);
});

test("verified purchasable stock still takes the Manifested fast path", () => {
  const signal = deriveSignal({
    previousOffer: null,
    currentOffer: offer({
      pricePence: 4999,
      stockStatus: "in_stock",
      stockConfidence: 0.98,
      evidence: [
        { kind: "structured_catalogue", value: "present" },
        { kind: "add_to_cart_verified", value: "true" },
      ],
    }),
    now: 200,
  });
  assert.equal(signal.state, "manifested");
  assert.equal(signal.kind, "new_listing_live");
});
