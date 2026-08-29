import test from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE_INCOMPLETE_ERROR_CODE, decorateCatalogueCompletenessStore } from "../src/stores/catalogue-completeness.mjs";

function fakeStore(previousProductsSeen = 80) {
  const calls = [];
  return {
    calls,
    async listRetailers() { return [{ id: "retailer-a", productsSeen: previousProductsSeen }]; },
    async saveScan(payload) { calls.push(payload); return { saved: true }; },
  };
}

test("suspicious catalogue collapse is rejected before underlying save", async () => {
  const store = decorateCatalogueCompletenessStore(fakeStore(80));
  await assert.rejects(
    () => store.saveScan({
      retailer: { id: "retailer-a", name: "Retailer A" },
      health: { source: "catalogue", productsSeen: 4 },
    }),
    (error) => error.code === CATALOGUE_INCOMPLETE_ERROR_CODE
      && error.catalogueCompleteness.reason === "suspicious_catalogue_collapse",
  );
  assert.equal(store.calls.length, 0);
});

test("normal catalogue movement reaches underlying save", async () => {
  const store = decorateCatalogueCompletenessStore(fakeStore(80));
  const result = await store.saveScan({
    retailer: { id: "retailer-a", name: "Retailer A" },
    health: { source: "catalogue", productsSeen: 76 },
  });
  assert.deepEqual(result, { saved: true });
  assert.equal(store.calls.length, 1);
});

test("external authenticated ingestion is not treated as a full catalogue replacement", async () => {
  const store = decorateCatalogueCompletenessStore(fakeStore(80));
  await store.saveScan({
    retailer: { id: "retailer-a", name: "Retailer A" },
    health: { source: "external", productsSeen: 1 },
  });
  assert.equal(store.calls.length, 1);
});
