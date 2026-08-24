import test from "node:test";
import assert from "node:assert/strict";
import { processRetailerProducts } from "../src/core/engine.mjs";

function referenceFixture() {
  let saved = null;
  const verifiedPack = {
    id: "official-destined-rivals-pack",
    canonicalKey: "booster_pack:scarlet violet 10 destined rivals booster pack",
    title: "Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack",
    productType: "booster_pack",
    tcg: "pokemon",
    officialRrpPence: 429,
    rrpSource: "asmodee-uk",
    rrpObservedAt: 1_780_000_000,
    firstSeenAt: 1_780_000_000,
    updatedAt: 1_780_000_000,
  };
  return {
    store: {
      isBaselineComplete: async () => true,
      listProducts: async () => [verifiedPack],
      getProduct: async () => null,
      getOffer: async () => null,
      saveScan: async (payload) => { saved = payload; },
    },
    saved: () => saved,
  };
}

test("lifecycle signal uses the shared verified pack RRP reference without promoting it to official product RRP", async () => {
  const fixture = referenceFixture();
  const result = await processRetailerProducts({
    retailer: { id: "double-sleeved", name: "Double Sleeved", tcg: "pokemon", delivery: { known: false } },
    store: fixture.store,
    source: "external",
    dispatchNotifications: false,
    now: 1_800_000_000,
    rawProducts: [{
      retailerSku: "DR-PACK-001",
      title: "Pokemon TCG: Destined Rivals - Booster Pack",
      url: "https://example.com/destined-rivals-pack",
      pricePence: 999,
      postagePence: null,
      stockStatus: "in_stock",
      stockConfidence: 0.99,
    }],
  });

  assert.equal(result.rrpInherited, 0, "reference matching must not masquerade as exact official-RRP inheritance");
  const saved = fixture.saved();
  assert.equal(saved.products[0].officialRrpPence, null);
  assert.equal(saved.products[0].rrpSource, null);
  assert.equal(saved.offers[0].rrpPence, 429);
  assert.equal(saved.signals.length, 1);
  assert.equal(saved.signals[0].state, "manifested");
  assert.equal(saved.signals[0].rrpPence, 429);
  assert.equal(saved.signals[0].markupPercent, 132.9);
  assert.equal(saved.signals[0].evidence.find((item) => item.kind === "rrp_value_kind")?.value, "pack_reference");
  assert.match(saved.signals[0].evidence.find((item) => item.kind === "rrp_value_source")?.value || "", /^reference:asmodee-uk$/);
  assert.equal(saved.signals[0].evidence.find((item) => item.kind === "rrp_reference_basis")?.value, "Verified booster-pack RRP reference for this set");
});

test("lifecycle signal stays UNKNOWN when no verified shared RRP/reference can be resolved", async () => {
  const fixture = referenceFixture();
  fixture.store.listProducts = async () => [];

  await processRetailerProducts({
    retailer: { id: "double-sleeved", name: "Double Sleeved", tcg: "pokemon", delivery: { known: false } },
    store: fixture.store,
    source: "external",
    dispatchNotifications: false,
    now: 1_800_000_001,
    rawProducts: [{
      retailerSku: "PORTFOLIO-001",
      title: "Pokemon TCG: Mini Portfolio - Q1 2026",
      url: "https://example.com/portfolio",
      pricePence: 999,
      postagePence: null,
      stockStatus: "in_stock",
      stockConfidence: 0.98,
    }],
  });

  const saved = fixture.saved();
  assert.equal(saved.offers[0].rrpPence, null);
  assert.equal(saved.signals[0].rrpPence, null);
  assert.equal(saved.signals[0].markupPercent, null);
  assert.equal(saved.signals[0].evidence.some((item) => item.kind === "rrp_value_kind"), false);
});