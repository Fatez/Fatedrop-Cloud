import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocalStockObservation } from "../src/encounters/local-stock-store.mjs";
import { buildLocalRadar, searchGoogleTcgShops } from "../src/encounters/local-radar.mjs";

const retailers = [
  { id: "smyths-uk", name: "Smyths Toys UK", baseUrl: "https://www.smythstoys.com/uk/en-gb/" },
  { id: "tesco-uk", name: "Tesco", baseUrl: "https://www.tesco.com/" },
];

function placesSearch() {
  return Promise.resolve({
    status: "ok",
    provider: "test_places",
    shops: [
      {
        id: "place-smyths-romford",
        itemType: "shop",
        provider: "google_places",
        providerPlaceId: "smyths-romford",
        name: "Smyths Toys Superstores Romford",
        address: "Romford",
        latitude: 51.58,
        longitude: 0.18,
        websiteUrl: null,
        localStockStatus: "unknown",
      },
      {
        id: "place-tesco-romford",
        itemType: "shop",
        provider: "google_places",
        providerPlaceId: "tesco-romford",
        name: "Tesco Extra Romford",
        address: "Romford",
        latitude: 51.59,
        longitude: 0.19,
        websiteUrl: null,
        localStockStatus: "unknown",
      },
    ],
  });
}

function storeWith(observations) {
  return {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listLocalStockObservations() { return observations; },
  };
}

test("curated retailer-chain Whisper can be branchless but is forced advisory", () => {
  const observation = normalizeLocalStockObservation({
    kind: "whisper",
    retailerId: "smyths-uk",
    occurredAt: Date.now(),
    evidence: {
      localIntel: true,
      scope: "retailer_chain",
      sourceType: "curated_manual",
      sourceId: "manual:test",
      rawProductTitle: "Phantasmal Flames Elite Trainer Box",
      expectedFrom: "2026-08-28T08:00:00+01:00",
      expectedTo: "2026-08-28T18:00:00+01:00",
      confidence: 0.45,
    },
  });

  assert.equal(observation.locationId, null);
  assert.equal(observation.kind, "whisper");
  assert.equal(observation.evidence.localIntel, true);
  assert.equal(observation.evidence.scope, "retailer_chain");
  assert.equal(observation.evidence.advisory, true);
  assert.equal(observation.evidence.expectedFrom, "2026-08-28T07:00:00.000Z");
  assert.equal(observation.evidence.expectedTo, "2026-08-28T17:00:00.000Z");
  assert.ok(observation.evidence.expiresAt, "expected window should create a useful automatic expiry when none is supplied");
});

test("generic curated manual intel cannot be promoted to Echo by assertion alone", () => {
  assert.throws(() => normalizeLocalStockObservation({
    kind: "echo",
    retailerId: "smyths-uk",
    occurredAt: Date.now(),
    evidence: {
      localIntel: true,
      scope: "retailer_chain",
      sourceType: "curated_manual",
      sourceId: "manual:test",
      rawProductTitle: "Phantasmal Flames Elite Trainer Box",
    },
  }), /Retailer-chain Echo requires/);
});

test("retailer staff evidence may create advisory chain Echo but never branch Manifested", () => {
  const echo = normalizeLocalStockObservation({
    kind: "echo",
    retailerId: "smyths-uk",
    occurredAt: Date.now(),
    evidence: {
      localIntel: true,
      scope: "retailer_chain",
      sourceType: "retailer_staff_report",
      sourceId: "staff:test",
      rawProductTitle: "Phantasmal Flames Elite Trainer Box",
    },
  });
  assert.equal(echo.kind, "echo");
  assert.equal(echo.locationId, null);
  assert.equal(echo.evidence.advisory, true);

  assert.throws(() => normalizeLocalStockObservation({
    kind: "manifested",
    retailerId: "smyths-uk",
    productIdentityId: "pokemon:phantasmal-flames-etb",
    occurredAt: Date.now(),
    evidence: {
      localIntel: true,
      scope: "retailer_chain",
      sourceType: "retailer_staff_report",
      evidenceLevel: "official_branch",
      availabilityVerified: true,
      stockStatus: "in_stock",
    },
  }), /Local Manifested requires an exact retailer location|only be Whisper or Echo/);
});

test("chain intel overlays only matching nearby retailer branches as unconfirmed incoming watch", async () => {
  const now = Date.now();
  const data = await buildLocalRadar({
    store: storeWith([{
      id: "intel-smyths-phantasmal",
      kind: "whisper",
      retailerId: "smyths-uk",
      locationId: null,
      occurredAt: now,
      productIdentityId: null,
      evidence: {
        localIntel: true,
        scope: "retailer_chain",
        advisory: true,
        sourceType: "curated_manual",
        sourceLabel: "FateDrop curated local intel",
        rawProductTitle: "Phantasmal Flames Elite Trainer Box",
        confidence: 0.45,
        expectedFrom: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        expectedTo: new Date(now + 36 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
        note: "Reported incoming retailer-chain stock; check the branch before travelling.",
      },
    }]),
    retailers,
    placesSearch,
    smythsAvailabilityRefresh: async () => ({ provider: "test", status: "skipped", productsChecked: 0, observationsSaved: 0, rejected: 0 }),
    latitude: 51.58,
    longitude: 0.18,
    types: ["shops"],
  });

  const smyths = data.shops.find((shop) => shop.retailerId === "smyths-uk");
  const tesco = data.shops.find((shop) => shop.retailerId === "tesco-uk");
  assert.ok(smyths);
  assert.ok(tesco);
  assert.equal(smyths.localStockStatus, "incoming_watch");
  assert.equal(smyths.localStockEvidence.lifecycleState, "whisper");
  assert.equal(smyths.localStockEvidence.advisory, true);
  assert.equal(smyths.localStockEvidence.scope, "retailer_chain");
  assert.equal(smyths.localStockEvidence.verifiedBranchStock, false);
  assert.equal(smyths.localStockProducts[0].title, "Phantasmal Flames Elite Trainer Box");
  assert.equal(smyths.localStockProducts[0].advisory, true);
  assert.equal(tesco.localStockStatus, "unknown", "Smyths chain intel must not leak onto Tesco");
  assert.equal(data.counts.incomingWatchBranches, 1);
});

test("Pokemon Local Radar discovery explicitly searches national physical card sellers as well as TCG shops", async () => {
  const queries = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    queries.push(body.textQuery);
    return { ok: true, async json() { return { places: [] }; } };
  };

  await searchGoogleTcgShops({
    apiKey: "test-key",
    latitude: 51.58,
    longitude: 0.18,
    radiusMiles: 10,
    tcg: "pokemon",
    fetchImpl,
  });

  assert.ok(queries.some((query) => query.includes("Smyths Toys")));
  assert.ok(queries.some((query) => query.includes("The Entertainer")));
  assert.ok(queries.some((query) => query.includes("Tesco")));
  assert.ok(queries.some((query) => query.includes("Argos")));
  assert.ok(queries.some((query) => query.includes("Sainsburys")));
});
