import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocalStockObservationBatch } from "../src/encounters/local-stock-store.mjs";
import { buildLocalRadar } from "../src/encounters/local-radar.mjs";

const SCREENSHOT_INTEL = Object.freeze({
  sourceType: "social_creator_post",
  sourceId: "instagram:robspokecentre:manual-screenshot:2026-08-27",
  sourceLabel: "robspokecentre Instagram stock-update screenshot",
  capturedAt: "2026-08-27T19:21:00+01:00",
  expectedFrom: "2026-08-28T00:00:00+01:00",
  expectedTo: "2026-08-28T23:59:59+01:00",
  rawProductTitle: "Destined Rivals Elite Trainer Box (inferred from ‘DR ETB’)",
  confidence: 0.4,
  evidenceBasis: "Manual screenshot of a creator stock-update post naming The Entertainer, Sports Direct and GAME for Friday 28 August. The DR ETB expansion is inferred, and the post does not prove branch-level stock.",
  retailers: Object.freeze([
    Object.freeze({ retailerId: "entertainer-uk", name: "The Entertainer", identityStatus: "canonical" }),
    Object.freeze({ retailerId: "game-uk", name: "GAME", identityStatus: "canonical" }),
    Object.freeze({ retailerId: null, name: "Sports Direct", identityStatus: "unresolved" }),
  ]),
});

function manualChainObservations() {
  return SCREENSHOT_INTEL.retailers
    .filter((retailer) => retailer.identityStatus === "canonical")
    .map((retailer) => ({
      kind: "whisper",
      retailerId: retailer.retailerId,
      occurredAt: Date.parse(SCREENSHOT_INTEL.capturedAt),
      evidence: {
        localIntel: true,
        scope: "retailer_chain",
        sourceType: SCREENSHOT_INTEL.sourceType,
        sourceId: `${SCREENSHOT_INTEL.sourceId}:${retailer.retailerId}`,
        sourceLabel: SCREENSHOT_INTEL.sourceLabel,
        rawProductTitle: SCREENSHOT_INTEL.rawProductTitle,
        expectedFrom: SCREENSHOT_INTEL.expectedFrom,
        expectedTo: SCREENSHOT_INTEL.expectedTo,
        confidence: SCREENSHOT_INTEL.confidence,
        evidenceBasis: SCREENSHOT_INTEL.evidenceBasis,
        productIdentityStatus: "inferred_unresolved",
        availabilityVerified: false,
        note: "Manual social lead only. Check the retailer/branch before travelling.",
      },
    }));
}

function storeWith(observations) {
  return {
    async listOffers() { return []; },
    async listEncounters() { return []; },
    async listLocalStockObservations() { return observations; },
  };
}

function placesSearch() {
  return Promise.resolve({
    status: "ok",
    provider: "manual-social-test",
    shops: [
      {
        id: "place-entertainer-watford",
        itemType: "shop",
        provider: "google_places",
        providerPlaceId: "entertainer-watford",
        name: "The Entertainer Watford",
        address: "Watford",
        latitude: 51.655,
        longitude: -0.397,
        websiteUrl: null,
        localStockStatus: "unknown",
      },
      {
        id: "place-game-watford",
        itemType: "shop",
        provider: "google_places",
        providerPlaceId: "game-watford",
        name: "GAME Watford",
        address: "Watford",
        latitude: 51.656,
        longitude: -0.398,
        websiteUrl: null,
        localStockStatus: "unknown",
      },
      {
        id: "place-sports-direct-watford",
        itemType: "shop",
        provider: "google_places",
        providerPlaceId: "sports-direct-watford",
        name: "Sports Direct Watford",
        address: "Watford",
        latitude: 51.657,
        longitude: -0.399,
        websiteUrl: null,
        localStockStatus: "unknown",
      },
    ],
  });
}

const retailers = [
  { id: "entertainer-uk", name: "The Entertainer", baseUrl: "https://www.thetoyshop.com/" },
  { id: "game-uk", name: "GAME UK", baseUrl: "https://www.game.co.uk/" },
];

test("manual creator screenshot becomes low-confidence retailer-chain Whisper only", () => {
  const batch = normalizeLocalStockObservationBatch(manualChainObservations());

  assert.equal(batch.received, 2);
  assert.equal(batch.accepted, 2);
  assert.equal(batch.rejected.length, 0);
  for (const observation of batch.observations) {
    assert.equal(observation.kind, "whisper");
    assert.equal(observation.locationId, null);
    assert.equal(observation.productIdentityId, null);
    assert.equal(observation.evidence.scope, "retailer_chain");
    assert.equal(observation.evidence.advisory, true);
    assert.equal(observation.evidence.availabilityVerified, false);
    assert.equal(observation.evidence.productIdentityStatus, "inferred_unresolved");
    assert.equal(observation.evidence.confidence, 0.4);
    assert.ok(observation.evidence.expiresAt, "manual incoming intel should expire after its expected window");
  }
});

test("unresolved Sports Direct identity is not invented and social intel cannot create branch stock", async () => {
  const batch = normalizeLocalStockObservationBatch(manualChainObservations());
  const data = await buildLocalRadar({
    store: storeWith(batch.observations),
    retailers,
    placesSearch,
    smythsAvailabilityRefresh: async () => ({ provider: "test", status: "skipped", productsChecked: 0, observationsSaved: 0, rejected: 0 }),
    latitude: 51.655,
    longitude: -0.397,
    types: ["shops"],
  });

  const entertainer = data.shops.find((shop) => shop.retailerId === "entertainer-uk");
  const game = data.shops.find((shop) => shop.retailerId === "game-uk");
  const sportsDirect = data.shops.find((shop) => shop.name === "Sports Direct Watford");

  assert.ok(entertainer);
  assert.ok(game);
  assert.ok(sportsDirect);
  assert.equal(entertainer.localStockStatus, "incoming_watch");
  assert.equal(game.localStockStatus, "incoming_watch");
  assert.equal(entertainer.localStockEvidence.lifecycleState, "whisper");
  assert.equal(game.localStockEvidence.lifecycleState, "whisper");
  assert.equal(entertainer.localStockEvidence.verifiedBranchStock, false);
  assert.equal(game.localStockEvidence.verifiedBranchStock, false);
  assert.equal(sportsDirect.localStockStatus, "unknown");
  assert.equal(SCREENSHOT_INTEL.retailers.find((retailer) => retailer.name === "Sports Direct").identityStatus, "unresolved");
});
