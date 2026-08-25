import test from "node:test";
import assert from "node:assert/strict";
import { createLiveOfferReadStore } from "../src/stores/live-offer-read-store.mjs";

test("live offer reads include only effectively healthy non-stale retailers", async () => {
  const store = {
    async listOffers() {
      return [
        { offerId: "fresh", retailerId: "fresh-shop" },
        { offerId: "stale", retailerId: "stale-shop" },
        { offerId: "failed", retailerId: "failed-shop" },
        { offerId: "unknown", retailerId: "unknown-shop" },
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

  const liveStore = createLiveOfferReadStore(store);
  const offers = await liveStore.listOffers({ limit: 100 });
  assert.deepEqual(offers.map((offer) => offer.offerId), ["fresh"]);
});

test("live offer reads fail closed when retailer health cannot be established", async () => {
  const store = {
    async listOffers() { return [{ offerId: "preserved", retailerId: "shop" }]; },
    async listRetailers() { throw new Error("health unavailable"); },
  };

  const liveStore = createLiveOfferReadStore(store);
  assert.deepEqual(await liveStore.listOffers(), []);
});

test("non-offer store methods remain bound to the underlying store", async () => {
  const store = {
    marker: "authority",
    async listOffers() { return []; },
    async listRetailers() { return []; },
    markerValue() { return this.marker; },
  };

  const liveStore = createLiveOfferReadStore(store);
  assert.equal(liveStore.markerValue(), "authority");
});
