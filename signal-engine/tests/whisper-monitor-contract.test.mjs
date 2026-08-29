import assert from "node:assert/strict";
import test from "node:test";

import { verifiedPurchasable } from "../src/core/preparation-intelligence.mjs";
import { deriveSignal, deriveSignals } from "../src/core/signals.mjs";

function offer(extra = {}) {
  return {
    offerId: "off_contract",
    productId: "prd_contract",
    retailerId: "test-retailer",
    retailerName: "Test Retailer",
    retailerSku: "SKU-001",
    title: "Pokemon Scarlet & Violet Booster Box",
    productType: "sealed",
    url: "https://example.com/pokemon-booster-box",
    imageUrl: null,
    pricePence: 4999,
    rrpPence: 4999,
    postagePence: null,
    stockStatus: "unknown",
    stockConfidence: 0.98,
    stockQuantity: null,
    evidence: [{ kind: "structured_catalogue", value: "present" }],
    everAvailableAt: null,
    firstSeenAt: 100,
    lastSeenAt: 100,
    ...extra,
  };
}

test("new exact structured SKU can Whisper while availability remains unknown", () => {
  const signal = deriveSignal({ previousOffer: null, currentOffer: offer(), now: 200 });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.kind, "catalogue_new");
});

test("verified official product page belongs to Whisper rather than catalogue-derived Echo", () => {
  const signal = deriveSignal({
    previousOffer: null,
    currentOffer: offer({ evidence: [{ kind: "official_retailer_product_page", value: "https://example.com/pokemon-booster-box" }] }),
    now: 200,
  });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.kind, "catalogue_new");
});

test("preorder metadata is broad early Whisper intelligence until purchase is verified", () => {
  const signal = deriveSignal({
    previousOffer: null,
    currentOffer: offer({
      stockStatus: "preorder",
      evidence: [
        { kind: "official_retailer_product_page", value: "https://example.com/pokemon-booster-box" },
        { kind: "preorder_metadata", value: "coming September" },
      ],
    }),
    now: 200,
  });
  assert.equal(signal.state, "whisper");
});

test("retailer in-stock wording that explicitly requires purchase verification remains Whisper", () => {
  const signal = deriveSignal({
    previousOffer: null,
    currentOffer: offer({
      stockStatus: "in_stock",
      evidence: [
        { kind: "official_retailer_catalogue_listing", value: "verified" },
        { kind: "purchase_verification_required", value: "smyths_purchase_control" },
      ],
    }),
    now: 200,
  });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.stockStatus, "in_stock");
});

test("verified purchase transition uses the Manifested fast path without inventing an Echo", () => {
  const previous = offer({
    stockStatus: "in_stock",
    lastSeenAt: 180,
    evidence: [
      { kind: "official_retailer_catalogue_listing", value: "verified" },
      { kind: "purchase_verification_required", value: "smyths_purchase_control" },
    ],
  });
  const current = offer({
    stockStatus: "in_stock",
    lastSeenAt: 200,
    evidence: [
      { kind: "official_retailer_catalogue_listing", value: "verified" },
      { kind: "purchase_verification_required", value: "smyths_purchase_control" },
      { kind: "add_to_cart_verified", value: "enabled" },
    ],
  });
  const signal = deriveSignal({ previousOffer: previous, currentOffer: current, now: 200 });
  assert.equal(signal.state, "manifested");
  assert.equal(signal.kind, "availability_live");
  assert.deepEqual(deriveSignals({ previousOffer: previous, currentOffer: current, now: 200 }).map((item) => item.state), ["manifested"]);
});

test("previously verified live stock going unavailable becomes Vanished", () => {
  const previous = offer({
    stockStatus: "in_stock",
    everAvailableAt: 50,
    lastSeenAt: 180,
    evidence: [
      { kind: "purchase_verification_required", value: "verified_control" },
      { kind: "add_to_cart_verified", value: "enabled" },
    ],
  });
  const current = offer({
    stockStatus: "out_of_stock",
    everAvailableAt: 50,
    lastSeenAt: 200,
    evidence: [{ kind: "structured_catalogue", value: "present" }],
  });
  const signal = deriveSignal({ previousOffer: previous, currentOffer: current, now: 200 });
  assert.equal(signal.state, "vanished");
  assert.equal(signal.kind, "sold_out");
});

test("quantity movement before verified availability is Whisper", () => {
  const signal = deriveSignal({
    previousOffer: offer({ stockStatus: "out_of_stock", stockQuantity: 0, lastSeenAt: 180 }),
    currentOffer: offer({ stockStatus: "out_of_stock", stockQuantity: 5, lastSeenAt: 200 }),
    now: 200,
  });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.kind, "inventory_quantity_change");
});

test("price movement before verified availability is Whisper", () => {
  const signal = deriveSignal({
    previousOffer: offer({ stockStatus: "out_of_stock", pricePence: null, lastSeenAt: 180 }),
    currentOffer: offer({ stockStatus: "out_of_stock", pricePence: 4999, lastSeenAt: 200 }),
    now: 200,
  });
  assert.equal(signal.state, "whisper");
  assert.equal(signal.kind, "catalogue_price_change");
});

test("meaningful product evidence change Whispers once while unchanged evidence stays quiet", () => {
  const previous = offer({
    stockStatus: "unknown",
    firstSeenAt: 100,
    lastSeenAt: 180,
    evidence: [{ kind: "structured_catalogue", value: "present" }],
  });
  const changed = offer({
    stockStatus: "unknown",
    firstSeenAt: 100,
    lastSeenAt: 200,
    evidence: [
      { kind: "structured_catalogue", value: "present" },
      { kind: "inventory_metadata", value: "exposed" },
    ],
  });
  const changedSignal = deriveSignal({ previousOffer: previous, currentOffer: changed, now: 200 });
  assert.equal(changedSignal.state, "whisper");
  assert.equal(changedSignal.kind, "product_evidence_change");

  const unchanged = offer({ stockStatus: "unknown", firstSeenAt: 100, lastSeenAt: 220, evidence: changed.evidence });
  assert.equal(deriveSignal({ previousOffer: changed, currentOffer: unchanged, now: 220 }), null);
});

test("catalogue preparation alone never becomes Echo", () => {
  const signal = deriveSignal({
    previousOffer: null,
    currentOffer: offer({
      stockStatus: "out_of_stock",
      evidence: [
        { kind: "structured_catalogue", value: "present" },
        { kind: "official_retailer_product_page", value: "https://example.com/pokemon-booster-box" },
        { kind: "inventory_metadata", value: "exposed" },
        { kind: "launch_date", value: "2026-09-01" },
      ],
    }),
    now: 200,
  });
  assert.equal(signal.state, "whisper");
});

test("purchase-verification-required state remains unavailable until real proof appears", () => {
  assert.equal(verifiedPurchasable(offer({
    stockStatus: "in_stock",
    evidence: [{ kind: "purchase_verification_required", value: "required" }],
  })), false);
  assert.equal(verifiedPurchasable(offer({
    stockStatus: "in_stock",
    evidence: [
      { kind: "purchase_verification_required", value: "required" },
      { kind: "purchase_path_verified", value: "enabled_add_to_cart" },
    ],
  })), true);
});
