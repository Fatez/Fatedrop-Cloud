import assert from "node:assert/strict";
import test from "node:test";

import { prioritizeLocalRadarShops } from "../src/encounters/local-radar-ranking.mjs";

test("Local Radar puts Manifested/confirmed branches before expected Echo evidence", () => {
  const shops = prioritizeLocalRadarShops([
    { id: "near-unknown", name: "Near Unknown", distanceMiles: 1, localAvailability: { status: "unknown", expected: null } },
    { id: "confirmed", name: "Confirmed", distanceMiles: 2, localAvailability: { status: "confirmed", expected: null } },
    { id: "expected-far", name: "Expected Far", distanceMiles: 18, localAvailability: { status: "expected", expected: { title: "Incoming Tin" } } },
    { id: "expected-near", name: "Expected Near", distanceMiles: 5, localAvailability: { status: "expected", expected: { title: "Incoming Box" } } },
  ]);

  assert.deepEqual(shops.map((shop) => shop.id), [
    "confirmed",
    "expected-near",
    "expected-far",
    "near-unknown",
  ]);
});

test("expected-stock priority does not rewrite a stronger confirmed truth state", () => {
  const [shop] = prioritizeLocalRadarShops([
    {
      id: "confirmed-with-expected",
      name: "Confirmed With Expected",
      distanceMiles: 7,
      localAvailability: {
        status: "confirmed",
        confirmed: { title: "Product A" },
        expected: { title: "Product B" },
      },
    },
  ]);

  assert.equal(shop.localAvailability.status, "confirmed");
  assert.equal(shop.localAvailability.expected.title, "Product B");
});

test("stores inside the same priority lane stay nearest-first with a stable name fallback", () => {
  const shops = prioritizeLocalRadarShops([
    { id: "b", name: "Beta", distanceMiles: 4, localAvailability: { status: "unknown" } },
    { id: "a", name: "Alpha", distanceMiles: 4, localAvailability: { status: "unknown" } },
    { id: "c", name: "Closer", distanceMiles: 2, localAvailability: { status: "unknown" } },
  ]);

  assert.deepEqual(shops.map((shop) => shop.id), ["c", "a", "b"]);
});
