import assert from "node:assert/strict";
import test from "node:test";

import { normalizeShopifyProducts } from "../src/adapters/shopify-normalizer.mjs";
import { normalizeWooStoreProducts } from "../src/adapters/woocommerce-normalizer.mjs";
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

function states(signals) {
  return signals.map((signal) => signal.state);
}

test("observed in-stock state without purchase proof is Whisper, not Manifested", () => {
  const signals = deriveSignals({
    previousOffer: offer({ stockStatus: "out_of_stock", lastSeenAt: 180 }),
    currentOffer: offer({ stockStatus: "in_stock", lastSeenAt: 200 }),
    now: 200,
  });
  assert.deepEqual(states(signals), ["whisper"]);
  assert.equal(signals[0].stockStatus, "in_stock");
  assert.equal(verifiedPurchasable(signals[0]), false);
});

test("verified live transition records Whisper observation plus Manifested confirmation", () => {
  const signals = deriveSignals({
    previousOffer: offer({ stockStatus: "out_of_stock", lastSeenAt: 180 }),
    currentOffer: offer({
      stockStatus: "in_stock",
      lastSeenAt: 200,
      evidence: [
        { kind: "structured_catalogue", value: "present" },
        { kind: "verified_stock_api", value: "retailer_authoritative_stock" },
      ],
    }),
    now: 200,
  });
  assert.deepEqual(states(signals), ["whisper", "manifested"]);
  assert.equal(signals[0].kind, "catalogue_state_change");
  assert.equal(signals[1].kind, "availability_live");
  assert.equal(deriveSignal({
    previousOffer: offer({ stockStatus: "out_of_stock", lastSeenAt: 180 }),
    currentOffer: offer({
      stockStatus: "in_stock",
      lastSeenAt: 200,
      evidence: [
        { kind: "structured_catalogue", value: "present" },
        { kind: "verified_stock_api", value: "retailer_authoritative_stock" },
      ],
    }),
    now: 200,
  }).state, "manifested");
});

test("brand-new verified live SKU keeps its Whisper origin beside Manifested", () => {
  const signals = deriveSignals({
    previousOffer: null,
    currentOffer: offer({
      stockStatus: "in_stock",
      lastSeenAt: 200,
      evidence: [
        { kind: "structured_catalogue", value: "present" },
        { kind: "verified_stock_api", value: "retailer_authoritative_stock" },
      ],
    }),
    now: 200,
  });
  assert.deepEqual(states(signals), ["whisper", "manifested"]);
  assert.equal(signals[0].kind, "catalogue_new");
  assert.equal(signals[1].kind, "new_listing_live");
});

test("previously verified live stock going unavailable records Whisper plus Vanished", () => {
  const previous = offer({
    stockStatus: "in_stock",
    everAvailableAt: 50,
    lastSeenAt: 180,
    evidence: [
      { kind: "structured_catalogue", value: "present" },
      { kind: "verified_stock_api", value: "retailer_authoritative_stock" },
    ],
  });
  const current = offer({
    stockStatus: "out_of_stock",
    everAvailableAt: 50,
    lastSeenAt: 200,
    evidence: [{ kind: "structured_catalogue", value: "present" }],
  });
  const signals = deriveSignals({ previousOffer: previous, currentOffer: current, now: 200 });
  assert.deepEqual(states(signals), ["whisper", "vanished"]);
  assert.equal(signals[1].kind, "sold_out");
});

test("unverified apparent stock going out is only Whisper and never Vanished", () => {
  const signals = deriveSignals({
    previousOffer: offer({ stockStatus: "in_stock", everAvailableAt: null, lastSeenAt: 180 }),
    currentOffer: offer({ stockStatus: "out_of_stock", lastSeenAt: 200 }),
    now: 200,
  });
  assert.deepEqual(states(signals), ["whisper"]);
});

test("quantity movement is a Whisper even when stock label is unchanged", () => {
  const signals = deriveSignals({
    previousOffer: offer({ stockStatus: "out_of_stock", stockQuantity: 0, lastSeenAt: 180 }),
    currentOffer: offer({ stockStatus: "out_of_stock", stockQuantity: 5, lastSeenAt: 200 }),
    now: 200,
  });
  assert.deepEqual(states(signals), ["whisper"]);
  assert.equal(signals[0].kind, "inventory_quantity_change");
});

test("meaningful evidence change creates one Whisper while unchanged evidence stays quiet", () => {
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
  const changedSignals = deriveSignals({ previousOffer: previous, currentOffer: changed, now: 200 });
  assert.equal(changedSignals.some((signal) => signal.state === "whisper"), true);

  const unchanged = offer({
    stockStatus: "unknown",
    firstSeenAt: 100,
    lastSeenAt: 220,
    evidence: changed.evidence,
  });
  const unchangedSignals = deriveSignals({ previousOffer: changed, currentOffer: unchanged, now: 220 });
  assert.equal(unchangedSignals.some((signal) => signal.state === "whisper"), false);
});

test("official preparation can coexist with Whisper instead of replacing it", () => {
  const signals = deriveSignals({
    previousOffer: null,
    currentOffer: offer({
      stockStatus: "unknown",
      evidence: [
        { kind: "structured_catalogue", value: "present" },
        { kind: "official_retailer_product_page", value: "https://example.com/pokemon-booster-box" },
      ],
    }),
    now: 200,
  });
  assert.deepEqual(states(signals), ["whisper", "echo"]);
});

test("verifiedPurchasable requires explicit confirmation evidence", () => {
  assert.equal(verifiedPurchasable(offer({ stockStatus: "in_stock" })), false);
  assert.equal(verifiedPurchasable(offer({
    stockStatus: "in_stock",
    evidence: [
      { kind: "structured_catalogue", value: "present" },
      { kind: "purchase_path_verified", value: "enabled_add_to_cart" },
    ],
  })), true);
});

test("Shopify structured live stock carries verified stock API proof", () => {
  const retailer = { baseUrl: "https://shop.example" };
  const live = normalizeShopifyProducts({ products: [{
    title: "Pokemon Booster Box",
    handle: "pokemon-booster-box",
    variants: [{ id: 1, sku: "SHOP-1", price: "99.99", available: true }],
    images: [],
  }] }, retailer)[0];
  const soldOut = normalizeShopifyProducts({ products: [{
    title: "Pokemon Booster Box",
    handle: "pokemon-booster-box",
    variants: [{ id: 2, sku: "SHOP-2", price: "99.99", available: false }],
    images: [],
  }] }, retailer)[0];
  assert.equal(live.evidence.some((entry) => entry.kind === "verified_stock_api"), true);
  assert.equal(soldOut.evidence.some((entry) => entry.kind === "verified_stock_api"), false);
});

test("WooCommerce structured live stock carries verified stock API proof", () => {
  const live = normalizeWooStoreProducts([{
    id: 1,
    name: "Pokemon Booster Box",
    sku: "WOO-1",
    permalink: "https://woo.example/pokemon-booster-box",
    is_in_stock: true,
    prices: { price: "9999", currency_minor_unit: 2 },
  }], {})[0];
  const soldOut = normalizeWooStoreProducts([{
    id: 2,
    name: "Pokemon Booster Box",
    sku: "WOO-2",
    permalink: "https://woo.example/pokemon-booster-box-2",
    is_in_stock: false,
    prices: { price: "9999", currency_minor_unit: 2 },
  }], {})[0];
  assert.equal(live.evidence.some((entry) => entry.kind === "verified_stock_api"), true);
  assert.equal(soldOut.evidence.some((entry) => entry.kind === "verified_stock_api"), false);
});
