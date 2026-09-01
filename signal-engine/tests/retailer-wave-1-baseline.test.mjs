import test from "node:test";
import assert from "node:assert/strict";

import { deriveSignal } from "../src/core/signals.mjs";
import { SIGNAL_DELIVERY_POLICIES } from "../src/core/signal-visibility-policy.mjs";

test("a newly enabled Wave 1 live offer creates a history-only baseline anchor, never an interrupt alert", () => {
  const now = 1_788_260_000;
  const signal = deriveSignal({
    previousOffer: null,
    isBaseline: true,
    now,
    currentOffer: {
      offerId: "off_wave1_baseline",
      productId: "prd_wave1_baseline",
      productType: "elite_trainer_box",
      retailerId: "tritex-games",
      retailerName: "Tritex Games",
      retailerSku: "WAVE1-ETB",
      title: "Pokemon TCG Elite Trainer Box",
      url: "https://example.co.uk/pokemon-etb",
      imageUrl: null,
      pricePence: 4999,
      rrpPence: null,
      postagePence: null,
      stockStatus: "in_stock",
      stockConfidence: 0.98,
      stockQuantity: null,
      evidence: [{ kind: "woocommerce_store_api", value: "product:wave1" }],
      language: null,
      region: null,
      retailerCountryCode: "GB",
      everAvailableAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });

  assert.ok(signal);
  assert.equal(signal.state, "manifested");
  assert.equal(signal.kind, "baseline_live_anchor");
  assert.equal(signal.deliveryPolicy, SIGNAL_DELIVERY_POLICIES.HISTORY_ONLY);
  assert.equal(signal.deliverySuppressed, true);
});
