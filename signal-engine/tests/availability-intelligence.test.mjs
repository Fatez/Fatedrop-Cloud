import assert from "node:assert/strict";
import test from "node:test";
import { buildAvailabilityIntelligence, buildAvailabilityWindows } from "../src/telemetry/availability-intelligence.mjs";

function signal(id, state, detectedAt, { offerId = "off-a", retailerId = "ret-a", retailerName = "Retailer A", productId = "prd-1" } = {}) {
  return { id, state, detectedAt, offerId, retailerId, retailerName, productId, title: "Test Product", pricePence: 1995 };
}

test("pairs Manifested to Vanished into evidence-backed availability windows", () => {
  const result = buildAvailabilityIntelligence([
    signal("m1", "manifested", 100),
    signal("v1", "vanished", 160),
    signal("m2", "manifested", 200),
    signal("v2", "vanished", 320),
  ], { now: 400 });

  assert.equal(result.sampleCount, 2);
  assert.equal(result.typicalAvailabilitySeconds, 90);
  assert.equal(result.averageAvailabilitySeconds, 90);
  assert.equal(result.shortestAvailabilitySeconds, 60);
  assert.equal(result.longestAvailabilitySeconds, 120);
  assert.equal(result.completedWindows[0].durationSeconds, 120);
  assert.equal(result.basis, "manifested_to_vanished");
});

test("keeps a live Manifested window open without polluting completed averages", () => {
  const result = buildAvailabilityIntelligence([
    signal("m1", "manifested", 100),
    signal("v1", "vanished", 160),
    signal("m2", "manifested", 300),
  ], { now: 345 });

  assert.equal(result.sampleCount, 1);
  assert.equal(result.typicalAvailabilitySeconds, 60);
  assert.equal(result.activeWindows.length, 1);
  assert.equal(result.activeWindows[0].observedLiveForSeconds, 45);
});

test("ignores orphan Vanished events and duplicate Manifested events", () => {
  const windows = buildAvailabilityWindows([
    signal("v0", "vanished", 50),
    signal("m1", "manifested", 100),
    signal("m1-duplicate", "manifested", 120),
    signal("v1", "vanished", 160),
  ], { now: 200 });

  assert.equal(windows.completed.length, 1);
  assert.equal(windows.completed[0].startedAt, 100);
  assert.equal(windows.completed[0].durationSeconds, 60);
});

test("uses median as typical availability so one long restock does not distort the headline", () => {
  const rows = [];
  const durations = [30, 40, 50, 60, 3600];
  let cursor = 100;
  durations.forEach((duration, index) => {
    rows.push(signal(`m${index}`, "manifested", cursor));
    rows.push(signal(`v${index}`, "vanished", cursor + duration));
    cursor += duration + 100;
  });
  const result = buildAvailabilityIntelligence(rows, { now: cursor + 100 });

  assert.equal(result.sampleCount, 5);
  assert.equal(result.typicalAvailabilitySeconds, 50);
  assert.equal(result.averageAvailabilitySeconds, 756);
});

test("builds retailer-specific availability intelligence without changing lifecycle semantics", () => {
  const rows = [
    signal("a-m1", "manifested", 100),
    signal("a-v1", "vanished", 140),
    signal("b-m1", "manifested", 200, { offerId: "off-b", retailerId: "ret-b", retailerName: "Retailer B" }),
    signal("b-v1", "vanished", 400, { offerId: "off-b", retailerId: "ret-b", retailerName: "Retailer B" }),
  ];
  const result = buildAvailabilityIntelligence(rows, { now: 500 });

  assert.equal(result.byRetailer.length, 2);
  assert.equal(result.byRetailer.find((row) => row.retailerId === "ret-a").typicalAvailabilitySeconds, 40);
  assert.equal(result.byRetailer.find((row) => row.retailerId === "ret-b").typicalAvailabilitySeconds, 200);
});
