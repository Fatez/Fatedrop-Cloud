import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processRetailerProducts } from "../src/core/engine.mjs";
import { FileStore } from "../src/stores/file-store.mjs";
import { loadAvailabilityIntelligence } from "../src/telemetry/availability-intelligence.mjs";

const retailer = {
  id: "chaos-cards",
  name: "Chaos Cards",
  tcg: "pokemon",
  officialRrpSource: false,
};

function raw(stockStatus) {
  return {
    retailerSku: "SKU-LIFECYCLE-1",
    title: "Lifecycle Test Elite Trainer Box",
    url: "https://example.test/lifecycle-etb",
    imageUrl: null,
    pricePence: 4999,
    postagePence: null,
    officialRrpPence: null,
    gtin: null,
    productType: "elite_trainer_box",
    canonicalKey: "lifecycle-test-elite-trainer-box",
    stockStatus,
    stockConfidence: 0.99,
    stockQuantity: stockStatus === "in_stock" ? 10 : 0,
    evidence: [{ kind: "test_observation", value: stockStatus }],
  };
}

async function scan(store, stockStatus, now) {
  return processRetailerProducts({
    retailer,
    store,
    rawProducts: [raw(stockStatus)],
    now,
    pagesScanned: 1,
    source: "catalogue",
    dispatchNotifications: false,
  });
}

test("quiet baseline stock cannot later create an orphan Vanished, while real Manifested windows still close cleanly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fatedrop-lifecycle-"));
  const store = new FileStore(path.join(dir, "state.json"));
  try {
    const baseline = await scan(store, "in_stock", 100);
    assert.equal(baseline.baseline, true);
    assert.equal(baseline.signals.length, 0);

    const baselineLoss = await scan(store, "out_of_stock", 200);
    assert.equal(baselineLoss.baseline, false);
    assert.equal(baselineLoss.signals.length, 0);

    const manifested = await scan(store, "in_stock", 300);
    assert.equal(manifested.signals.length, 1);
    assert.equal(manifested.signals[0].state, "manifested");
    const manifestedId = manifested.signals[0].id;
    const opened = manifested.signals[0].evidence.find((entry) => entry?.kind === "availability_window");
    assert.equal(opened?.status, "opened");
    assert.equal(opened?.manifestedSignalId, manifestedId);

    const vanished = await scan(store, "out_of_stock", 400);
    assert.equal(vanished.signals.length, 1);
    assert.equal(vanished.signals[0].state, "vanished");
    assert.equal(vanished.signals[0].pairedManifestedSignalId, manifestedId);
    const closed = vanished.signals[0].evidence.find((entry) => entry?.kind === "availability_window");
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.manifestedSignalId, manifestedId);

    const intelligence = await loadAvailabilityIntelligence(store, {
      offerId: vanished.signals[0].offerId,
      since: 0,
      now: 500,
    });
    assert.equal(intelligence.completedWindows.length, 1);
    assert.equal(intelligence.completedWindows[0].manifestedSignalId, manifestedId);
    assert.equal(intelligence.completedWindows[0].vanishedSignalId, vanished.signals[0].id);
    assert.equal(intelligence.completedWindows[0].durationSeconds, 100);
    assert.equal(intelligence.activeWindows.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
