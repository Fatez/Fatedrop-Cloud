import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureTotalCardsGamingCentre,
  parseTotalCardsPhysicalAvailability,
  reconcileTotalCardsPhysicalAvailability,
} from "../src/encounters/total-cards-local-availability.mjs";

const LOCATION = {
  id: "loc-total-cards-newton-aycliffe",
  retailerId: "total-cards",
  provider: "total_cards_official_gaming_centre",
  providerId: "https://totalcards.net/pages/we-buy-any-cards",
  name: "Total Cards Gaming Centre",
  address: "Unit 6, Maple Way, Aycliffe Business Park, Newton Aycliffe",
  postcode: "DL5 6BF",
  latitude: 54.6201,
  longitude: -1.5744,
};

const CANDIDATE = {
  id: "perfect-order",
  retailerId: "total-cards",
  productUrl: "https://totalcards.net/products/pokemon-mega-evolution-perfect-order-booster-pack",
  expectedTitle: "Pokemon - Mega Evolution - Perfect Order - Booster Pack",
};

const RESOLVED = {
  product_id: "prd-perfect-order",
  offer_id: "off-perfect-order",
  offer_title: CANDIDATE.expectedTitle,
  offer_url: `${CANDIDATE.productUrl}?variant=123`,
  official_rrp_pence: 429,
  rrp_source: "asmodee-uk",
};

function productHtml(body, price = "6.95") {
  return `<!doctype html><html><body>${body}<script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    name: CANDIDATE.expectedTitle,
    offers: { "@type": "Offer", price, priceCurrency: "GBP" },
  })}</script></body></html>`;
}

function response({ ok = true, status = 200, text = "", json = null } = {}) {
  return {
    ok,
    status,
    async text() { return text; },
    async json() { return json; },
  };
}

test("physical availability requires explicit Pickup Only plus Available to buy in-store", () => {
  const positive = parseTotalCardsPhysicalAvailability(productHtml("Sold out Pickup Only Available to buy in-store"));
  assert.equal(positive.physicalAvailable, true);
  assert.equal(positive.pickupOnly, true);
  assert.equal(positive.availableInStore, true);
  assert.equal(positive.pricePence, 695);

  const pickupOnly = parseTotalCardsPhysicalAvailability(productHtml("Sold out Pickup Only"));
  assert.equal(pickupOnly.physicalAvailable, false);
  assert.equal(pickupOnly.explicitPhysicalUnavailable, false, "online sold-out must not be interpreted as physical branch unavailability");
});

test("only explicit physical collection unavailability can qualify a later Vanished observation", () => {
  const onlineOnly = parseTotalCardsPhysicalAvailability(productHtml("Sold out Pickup Only"));
  assert.equal(onlineOnly.explicitPhysicalUnavailable, false);

  const physicalNegative = parseTotalCardsPhysicalAvailability(productHtml("Pickup Only Not available in-store"));
  assert.equal(physicalNegative.physicalAvailable, false);
  assert.equal(physicalNegative.explicitPhysicalUnavailable, true);
});

test("official Gaming Centre page establishes the exact Total Cards branch without claiming stock", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return []; },
    async upsertRetailerLocations(rows) { saved.push(...rows); return { saved: rows.length }; },
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("postcodes.io")) {
      return response({ json: { result: { latitude: 54.6201, longitude: -1.5744 } } });
    }
    return response({ text: "<html><body>Total Cards Gaming Centre Unit 6 Maple Way Newton Aycliffe DL5 6BF</body></html>" });
  };

  const result = await ensureTotalCardsGamingCentre({ store, fetchImpl, now: Date.parse("2026-08-26T18:00:00+01:00") });
  assert.equal(result.status, "saved");
  assert.equal(result.saved, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].retailerId, "total-cards");
  assert.equal(saved[0].provider, "total_cards_official_gaming_centre");
  assert.equal(saved[0].postcode, "DL5 6BF");
  assert.equal(saved[0].verification, "official_retailer_branch");
});

test("exact official in-store evidence creates Local Manifested while online stock remains irrelevant", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return [LOCATION]; },
    async getLatestLocalPhysicalState() { return null; },
    async upsertLocalStockObservations(rows) { saved.push(...rows); return { saved: rows.length, duplicates: 0 }; },
  };
  const result = await reconcileTotalCardsPhysicalAvailability({
    store,
    candidates: [CANDIDATE],
    resolveCandidate: async () => ({ status: "resolved", row: RESOLVED }),
    fetchImpl: async () => response({ text: productHtml("Sold out Pickup Only Available to buy in-store") }),
    now: Date.parse("2026-08-26T18:05:00+01:00"),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.saved, 1);
  assert.equal(saved.length, 1);
  const event = saved[0];
  assert.equal(event.kind, "manifested");
  assert.equal(event.retailerId, "total-cards");
  assert.equal(event.locationId, LOCATION.id);
  assert.equal(event.productIdentityId, RESOLVED.product_id);
  assert.equal(event.offerId, null, "local physical evidence must not attach a fatedrop_retail_offers ID to the legacy fatedrop_offers foreign key");
  assert.equal(event.evidence.sourceUrl, CANDIDATE.productUrl, "official product URL remains the physical evidence source even without an online offer FK");
  assert.equal(event.evidence.evidenceLevel, "official_collection");
  assert.equal(event.evidence.availabilityVerified, true);
  assert.equal(event.evidence.stockStatus, "collection_available");
  assert.equal(event.evidence.itemPricePence, 695);
  assert.equal(event.evidence.rrpPence, 429);
  assert.equal(event.evidence.rrpSource, "asmodee-uk");
});

test("unknown or ambiguous physical state fails closed and never infers from online sold-out", async () => {
  let writes = 0;
  const store = {
    async listRetailerLocations() { return [LOCATION]; },
    async getLatestLocalPhysicalState() { return null; },
    async upsertLocalStockObservations() { writes += 1; return { saved: 0 }; },
  };
  const result = await reconcileTotalCardsPhysicalAvailability({
    store,
    candidates: [CANDIDATE],
    resolveCandidate: async () => ({ status: "resolved", row: RESOLVED }),
    fetchImpl: async () => response({ text: productHtml("Sold out Pickup Only") }),
  });
  assert.equal(result.saved, 0);
  assert.equal(writes, 0);
  assert.equal(result.results[0].status, "physical_state_unknown");
});

test("missing or ambiguous canonical product resolution saves nothing", async () => {
  let fetches = 0;
  let writes = 0;
  const store = {
    async listRetailerLocations() { return [LOCATION]; },
    async upsertLocalStockObservations() { writes += 1; return { saved: 0 }; },
  };
  const result = await reconcileTotalCardsPhysicalAvailability({
    store,
    candidates: [CANDIDATE],
    resolveCandidate: async () => ({ status: "ambiguous", row: null, matches: 2 }),
    fetchImpl: async () => { fetches += 1; return response({ text: productHtml("Pickup Only Available to buy in-store") }); },
  });
  assert.equal(result.saved, 0);
  assert.equal(fetches, 0, "do not even consume branch-stock evidence until canonical product identity resolves uniquely");
  assert.equal(writes, 0);
  assert.equal(result.results[0].status, "ambiguous");
});

test("already Manifested exact branch/product is not duplicated", async () => {
  let writes = 0;
  const store = {
    async listRetailerLocations() { return [LOCATION]; },
    async getLatestLocalPhysicalState() { return { kind: "manifested", occurred_at: 1787760000 }; },
    async upsertLocalStockObservations() { writes += 1; return { saved: 0 }; },
  };
  const result = await reconcileTotalCardsPhysicalAvailability({
    store,
    candidates: [CANDIDATE],
    resolveCandidate: async () => ({ status: "resolved", row: RESOLVED }),
    fetchImpl: async () => response({ text: productHtml("Pickup Only Available to buy in-store") }),
  });
  assert.equal(result.saved, 0);
  assert.equal(writes, 0);
  assert.equal(result.results[0].status, "already_manifested");
});

test("real Vanished requires explicit physical-negative evidence after prior exact-branch Manifested", async () => {
  const saved = [];
  const store = {
    async listRetailerLocations() { return [LOCATION]; },
    async getLatestLocalPhysicalState() { return { kind: "manifested", occurred_at: 1787760000 }; },
    async hasPriorLocalManifested() { return true; },
    async upsertLocalStockObservations(rows) { saved.push(...rows); return { saved: rows.length, duplicates: 0 }; },
  };
  const result = await reconcileTotalCardsPhysicalAvailability({
    store,
    candidates: [CANDIDATE],
    resolveCandidate: async () => ({ status: "resolved", row: RESOLVED }),
    fetchImpl: async () => response({ text: productHtml("Pickup Only Store collection unavailable") }),
    now: Date.parse("2026-08-26T18:15:00+01:00"),
  });
  assert.equal(result.saved, 1);
  assert.equal(saved[0].kind, "vanished");
  assert.equal(saved[0].locationId, LOCATION.id);
  assert.equal(saved[0].productIdentityId, RESOLVED.product_id);
  assert.equal(saved[0].evidence.stockStatus, "collection_unavailable");
  assert.equal(saved[0].evidence.availabilityVerified, false);
});