import assert from "node:assert/strict";
import test from "node:test";
import { decorateRetailerHealthStore, effectiveRetailerHealth } from "../src/stores/health-staleness.mjs";

const NOW = 2_000_000;

test("recent successful retailer remains operationally healthy", () => {
  const result = effectiveRetailerHealth({ id: "recent", healthy: true, lastSuccessAt: NOW - 600 }, { now: NOW, staleAfterSeconds: 1800 });
  assert.equal(result.lastRunHealthy, true);
  assert.equal(result.stale, false);
  assert.equal(result.healthy, true);
});

test("old successful retailer becomes stale without rewriting its last-run truth", () => {
  const result = effectiveRetailerHealth({ id: "old", healthy: true, lastSuccessAt: NOW - 1801 }, { now: NOW, staleAfterSeconds: 1800 });
  assert.equal(result.lastRunHealthy, true);
  assert.equal(result.stale, true);
  assert.equal(result.healthy, false);
});

test("file-store style healthy record can use lastScanAt as successful freshness", () => {
  const result = effectiveRetailerHealth({ id: "file", healthy: true, lastScanAt: NOW - 120 }, { now: NOW, staleAfterSeconds: 1800 });
  assert.equal(result.lastSuccessAt, NOW - 120);
  assert.equal(result.stale, false);
  assert.equal(result.healthy, true);
});

test("failed retailer stays unhealthy without being mislabeled stale", () => {
  const result = effectiveRetailerHealth({ id: "failed", healthy: false, lastSuccessAt: NOW - 7200 }, { now: NOW, staleAfterSeconds: 1800 });
  assert.equal(result.lastRunHealthy, false);
  assert.equal(result.stale, false);
  assert.equal(result.healthy, false);
});

test("store decoration applies effective health to every health consumer", async () => {
  const store = {
    marker: "preserved",
    async listRetailers() {
      return [
        { id: "fresh", healthy: true, lastSuccessAt: NOW - 60 },
        { id: "stale", healthy: true, lastSuccessAt: NOW - 3600 },
      ];
    },
  };
  const decorated = decorateRetailerHealthStore(store, { now: NOW, staleAfterSeconds: 1800 });
  assert.equal(decorated, store);
  assert.equal(decorated.marker, "preserved");
  const retailers = await decorated.listRetailers();
  assert.equal(retailers[0].healthy, true);
  assert.equal(retailers[0].stale, false);
  assert.equal(retailers[1].healthy, false);
  assert.equal(retailers[1].stale, true);
});
