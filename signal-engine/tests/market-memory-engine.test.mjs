import assert from "node:assert/strict";
import test from "node:test";

import { processRetailerProducts } from "../src/core/engine.mjs";

function fixtureStore({ previousProduct = null, products = [] } = {}) {
  let saved = null;
  return {
    store: {
      isBaselineComplete: async () => true,
      listProducts: async () => products,
      getProduct: async () => previousProduct,
      getOffer: async () => null,
      saveScan: async (payload) => { saved = payload; },
    },
    saved: () => saved,
  };
}

const retailer = { id: "example-cards", name: "Example Cards", tcg: "pokemon", delivery: { known: false } };

async function processOne(fixture, input) {
  return processRetailerProducts({
    retailer,
    store: fixture.store,
    source: "external",
    dispatchNotifications: false,
    now: 1_800_000_000,
    rawProducts: [{
      retailerSku: "sku-1",
      url: "https://example.test/product",
      pricePence: 2999,
      stockStatus: "in_stock",
      stockConfidence: 0.99,
      ...input,
    }],
  });
}

test("engine verifies market from exact official source-market authority and persists alert evidence", async () => {
  const fixture = fixtureStore();
  await processOne(fixture, {
    title: "Abyss Eye Japanese Booster Pack",
    productType: "booster_pack",
  });
  const offer = fixture.saved().offers[0];
  assert.equal(offer.facets.marketStatus, "verified");
  assert.equal(offer.facets.marketCode, "JP");
  assert.equal(offer.facets.marketGroup, "japanese");
  assert.equal(offer.evidence.find((item) => item.kind === "canonical_market_resolution")?.marketCode, "JP");
  assert.equal(offer.rrpPence, 92);
});

test("engine keeps language metadata separate from market identity", async () => {
  const fixture = fixtureStore();
  await processOne(fixture, {
    title: "Abyss Eye Booster Pack",
    productType: "booster_pack",
    language: "ja",
  });
  const offer = fixture.saved().offers[0];
  assert.equal(offer.facets.languageGroup, "japanese");
  assert.equal(offer.facets.marketStatus, "unknown");
  assert.equal(offer.facets.marketCode, null);
});

test("recognized import with unresolved market authority cannot fall back to a stored UK RRP", async () => {
  const fixture = fixtureStore({
    previousProduct: {
      title: "Unknown Future Set Japanese Booster Pack",
      productType: "booster_pack",
      officialRrpPence: 429,
      rrpSource: "asmodee-uk",
      rrpObservedAt: 1_700_000_000,
      firstSeenAt: 1_700_000_000,
    },
  });
  await processOne(fixture, {
    title: "Unknown Future Set Japanese Booster Pack",
    productType: "booster_pack",
  });
  const offer = fixture.saved().offers[0];
  assert.equal(offer.rrpPence, null);
  assert.equal(offer.facets.marketStatus, "candidate");
  assert.equal(offer.facets.marketCode, null);
});
