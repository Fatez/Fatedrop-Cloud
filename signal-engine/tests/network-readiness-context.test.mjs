import assert from "node:assert/strict";
import test from "node:test";

import { recordRetailerReadiness } from "../src/core/network-readiness.mjs";

const retailer = { id: "pokemon-center-uk", name: "Pokémon Center UK" };

function contextSignal(overrides = {}) {
  return {
    id: "sig_context_1",
    state: "manifested",
    productId: "prd_context_1",
    offerId: "off_context_1",
    retailerId: retailer.id,
    retailerName: retailer.name,
    title: "Pokémon TCG Context Product",
    productType: "elite_trainer_box",
    url: "https://example.test/context",
    imageUrl: null,
    pricePence: 5499,
    rrpPence: 5499,
    postagePence: 0,
    deliveredPricePence: 5499,
    markupPercent: 0,
    stockStatus: "in_stock",
    previousStockStatus: "out_of_stock",
    confidence: 1,
    detectedAt: 1_787_500_000,
    reason: "Verified stock",
    evidence: [],
    ...overrides,
  };
}

test("Echo can use recent real retailer activity when no recent Whisper exists", async () => {
  const appended = [];
  let query = null;
  const store = {
    async listSignals(options) {
      query = options;
      return [contextSignal()];
    },
    async appendSignals(signals) {
      appended.push(...signals);
    },
  };

  const observedAt = 1_787_520_000;
  const result = await recordRetailerReadiness({
    retailer,
    store,
    state: "queue",
    previousState: "normal",
    observedAt,
    evidence: [{ kind: "browser_state", label: "queue" }],
  });

  assert.deepEqual(query.states, ["whisper", "manifested", "vanished"]);
  assert.equal(query.retailerIds[0], retailer.id);
  assert.equal(query.since, observedAt - (7 * 24 * 60 * 60));
  assert.equal(result.reason, "echo_emitted");
  assert.equal(result.productContexts, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].state, "echo");
  assert.equal(appended[0].kind, "queue");
  assert.equal(appended[0].productId, "prd_context_1");
  assert.match(appended[0].reason, /recent retailer activity only/i);
  assert.ok(appended[0].evidence.some((item) => item.kind === "echo_product_context" && item.sourceState === "manifested"));
});
