import test from "node:test";
import assert from "node:assert/strict";
import { createLiveOfferReadStore, freshOfferObservation } from "../src/stores/live-offer-read-store.mjs";

const NOW = 2_000_000_000;

test("live offer reads require both an effectively healthy retailer and a fresh offer observation", async () => {
  const store = {
    async listOffers() {
      return [
        { offerId: "fresh", retailerId: "fresh-shop", lastSeenAt: NOW - 30 },
        { offerId: "stale-offer", retailerId: "fresh-shop", lastSeenAt: NOW - 1801 },
        { offerId: "missing-time", retailerId: "fresh-shop", lastSeenAt: null },
        { offerId: "stale-retailer", retailerId: "stale-shop", lastSeenAt: NOW - 30 },
        { offerId: "failed", retailerId: "failed-shop", lastSeenAt: NOW - 30 },
        { offerId: "unknown", retailerId: "unknown-shop", lastSeenAt: NOW - 30 },
      ];
    },
    async listRetailers() {
      return [
        { id: "fresh-shop", healthy: true, stale: false },
        { id: "stale-shop", healthy: false, stale: true },
        { id: "failed-shop", healthy: false, stale: false },
      ];
    },
  };

  const liveStore = createLiveOfferReadStore(store, { now: NOW });
  const offers = await liveStore.listOffers({ limit: 100 });
  assert.deepEqual(offers.map((offer) => offer.offerId), ["fresh"]);
});

test("offer freshness fails closed for missing, stale, or implausibly future observations", () => {
  assert.equal(freshOfferObservation({ lastSeenAt: NOW }, { now: NOW }), true);
  assert.equal(freshOfferObservation({ lastSeenAt: NOW - 1800 }, { now: NOW }), true);
  assert.equal(freshOfferObservation({ lastSeenAt: NOW - 1801 }, { now: NOW }), false);
  assert.equal(freshOfferObservation({ lastSeenAt: null }, { now: NOW }), false);
  assert.equal(freshOfferObservation({ lastSeenAt: 0 }, { now: NOW }), false);
  assert.equal(freshOfferObservation({ lastSeenAt: NOW + 300 }, { now: NOW }), true);
  assert.equal(freshOfferObservation({ lastSeenAt: NOW + 301 }, { now: NOW }), false);
});

test("live offer reads fail closed when retailer health cannot be established", async () => {
  const store = {
    async listOffers() { return [{ offerId: "preserved", retailerId: "shop", lastSeenAt: NOW }]; },
    async listRetailers() { throw new Error("health unavailable"); },
  };

  const liveStore = createLiveOfferReadStore(store, { now: NOW });
  assert.deepEqual(await liveStore.listOffers(), []);
});

test("non-offer store methods remain bound to the underlying store", async () => {
  const store = {
    marker: "authority",
    async listOffers() { return []; },
    async listRetailers() { return []; },
    markerValue() { return this.marker; },
  };

  const liveStore = createLiveOfferReadStore(store, { now: NOW });
  assert.equal(liveStore.markerValue(), "authority");
});
