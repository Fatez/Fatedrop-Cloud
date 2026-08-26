import test from "node:test";
import assert from "node:assert/strict";
import { processRetailerProducts } from "../src/core/engine.mjs";

function storeWithVerifiedRrp() {
  let saved = null;
  return {
    store: {
      isBaselineComplete: async () => true,
      listProducts: async () => [{
        id: "verified-etb",
        canonicalKey: "elite_trainer_box:mega evolution phantasmal flames elite trainer box",
        title: "Pokémon TCG: Mega Evolution Phantasmal Flames Elite Trainer Box",
        productType: "elite_trainer_box",
        tcg: "pokemon",
        officialRrpPence: 4999,
        rrpSource: "asmodee-uk",
        rrpObservedAt: 1_700_000_000,
        firstSeenAt: 1_700_000_000,
        updatedAt: 1_700_000_000,
      }],
      getProduct: async () => null,
      getOffer: async () => null,
      saveScan: async (payload) => { saved = payload; },
    },
    saved: () => saved,
  };
}

test("retailer alias inherits durable verified RRP before Manifested signal is derived", async () => {
  const fixture = storeWithVerifiedRrp();
  const retailer = { id: "example-cards", name: "Example Cards", tcg: "pokemon", delivery: { known: false } };
  const now = 1_800_000_000;

  const result = await processRetailerProducts({
    retailer,
    store: fixture.store,
    source: "external",
    dispatchNotifications: false,
    now,
    rawProducts: [{
      retailerSku: "PF-ETB-001",
      title: "Pokemon Mega Evolution Phantasmal Flames ETB",
      url: "https://example.com/phantasmal-flames-etb",
      pricePence: 6999,
      postagePence: 0,
      stockStatus: "in_stock",
      stockConfidence: 0.99,
    }],
  });

  assert.equal(result.rrpInherited, 1);
  const saved = fixture.saved();
  assert.equal(saved.products.length, 1);
  assert.equal(saved.products[0].officialRrpPence, 4999);
  assert.equal(saved.products[0].rrpSource, "asmodee-uk");
  assert.equal(saved.offers[0].rrpPence, 4999);
  assert.equal(saved.signals.length, 1);
  assert.equal(saved.signals[0].state, "manifested");
  assert.equal(saved.signals[0].rrpPence, 4999);
  assert.equal(saved.signals[0].markupPercent, 40);
});

test("conflicting canonical RRP evidence does not contaminate a retailer offer", async () => {
  const fixture = storeWithVerifiedRrp();
  fixture.store.listProducts = async () => [
    ...(await storeWithVerifiedRrp().store.listProducts()),
    {
      id: "verified-etb-conflict",
      title: "Pokemon Mega Evolution Phantasmal Flames Elite Trainer Box",
      productType: "elite_trainer_box",
      tcg: "pokemon",
      officialRrpPence: 5499,
      rrpSource: "other-authority",
      rrpObservedAt: 1_700_000_100,
    },
  ];

  const result = await processRetailerProducts({
    retailer: { id: "example-cards", name: "Example Cards", tcg: "pokemon", delivery: { known: false } },
    store: fixture.store,
    source: "external",
    dispatchNotifications: false,
    now: 1_800_000_000,
    rawProducts: [{
      retailerSku: "PF-ETB-002",
      title: "Pokemon Mega Evolution Phantasmal Flames ETB",
      url: "https://example.com/phantasmal-flames-etb-2",
      pricePence: 6999,
      postagePence: 0,
      stockStatus: "in_stock",
      stockConfidence: 0.99,
    }],
  });

  assert.equal(result.rrpInherited, 0);
  const saved = fixture.saved();
  assert.equal(saved.products[0].officialRrpPence, null);
  assert.equal(saved.offers[0].rrpPence, null);
  assert.equal(saved.signals[0].markupPercent, null);
});

test("SWSH retailer abbreviation resolves the verified Silver Tempest booster-box RRP", async () => {
  let saved = null;
  const store = {
    isBaselineComplete: async () => true,
    listProducts: async () => [{
      id: "verified-silver-tempest-box",
      canonicalKey: "booster_box:sword and shield silver tempest booster display box 36 packs",
      title: "Pokémon TCG: Sword & Shield-Silver Tempest Booster Display Box (36 Packs)",
      productType: "booster_box",
      tcg: "pokemon",
      officialRrpPence: 13499,
      rrpSource: "pokemon-center-uk",
      rrpObservedAt: 1_787_313_615,
      firstSeenAt: 1_787_313_615,
      updatedAt: 1_787_313_615,
    }],
    getProduct: async () => null,
    getOffer: async () => null,
    saveScan: async (payload) => { saved = payload; },
  };

  const result = await processRetailerProducts({
    retailer: { id: "magic-madhouse", name: "Magic Madhouse", tcg: "pokemon", delivery: { known: true, standardPence: 0 } },
    store,
    source: "external",
    dispatchNotifications: false,
    now: 1_800_000_000,
    rawProducts: [{
      retailerSku: "1 piece",
      title: "SWSH Silver Tempest Booster Box",
      productType: "booster_box",
      url: "https://magicmadhouse.co.uk/pokemon-swsh-silver-tempest-booster-box",
      pricePence: 59995,
      postagePence: 0,
      stockStatus: "in_stock",
      stockConfidence: 0.98,
    }],
  });

  assert.equal(result.rrpInherited, 1);
  assert.equal(saved.products[0].officialRrpPence, 13499);
  assert.equal(saved.products[0].rrpSource, "pokemon-center-uk");
  assert.equal(saved.offers[0].rrpPence, 13499);
  assert.equal(saved.signals[0].rrpPence, 13499);
  assert.equal(saved.signals[0].markupPercent, 344.4);
});
