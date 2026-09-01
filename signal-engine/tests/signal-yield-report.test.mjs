import assert from "node:assert/strict";
import test from "node:test";

import { buildSignalYieldReport } from "../src/telemetry/signal-yield-report.mjs";

test("signal yield report joins scan, observation, candidate, suppression and delivery stages", () => {
  const now = 1_800_000_000;
  const report = buildSignalYieldReport({
    now,
    since: now - 3600,
    configuredRetailers: [{ id: "shop", name: "Shop", adapterType: "shopify" }],
    runRows: [{
      retailer_id: "shop",
      status: "success",
      pages_scanned: 2,
      products_observed: 10,
      diagnostics: { discovery: { rawProductsSeen: 12, normalizedProductsSeen: 12, filteredOutProducts: 2 } },
    }],
    observationRows: [
      {
        retailer_id: "shop",
        offer_id: "offer-1",
        observed_at: now - 100,
        title: "Pokemon TCG Booster Box",
        product_type: "booster_box",
        stock_status: "out_of_stock",
        evidence: [{ kind: "canonical_market_resolution", status: "unknown" }],
      },
      {
        retailer_id: "shop",
        offer_id: "offer-2",
        observed_at: now - 90,
        title: "Pokemon TCG Elite Trainer Box",
        product_type: "elite_trainer_box",
        stock_status: "preorder",
        evidence: [{ kind: "preorder_metadata" }],
      },
      {
        retailer_id: "shop",
        offer_id: "offer-3",
        observed_at: now - 80,
        title: "Pokemon Card Sleeves",
        product_type: "accessory",
        stock_status: "in_stock",
        evidence: [],
      },
    ],
    signalRows: [{
      id: "sig-1",
      state: "whisper",
      retailer_id: "shop",
      retailer_name: "Shop",
      offer_id: "offer-1",
      detected_at: now - 100,
    }],
    conflictRows: [{ retailer_id: "shop", stage: "manifested", reason: "invalid_transition", count: 1 }],
    readinessRows: [{ retailer_id: "shop", count: 2 }],
    outboxRows: [
      { retailer_id: "shop", outbox_state: "provider_accepted", delivery_policy: "interrupt", count: 1 },
      { retailer_id: "shop", outbox_state: "suppressed", delivery_policy: "inbox_only", last_error: "policy_inbox_only", count: 1 },
    ],
    healthRows: [{ id: "shop", name: "Shop", healthy: true, lastScanAt: now - 60, lastSuccessAt: now - 60, baselineCompleted: true }],
  });

  const row = report.retailers[0];
  assert.equal(row.scans.attempted, 1);
  assert.equal(row.scans.offersObserved, 10);
  assert.equal(row.discovery.filteredOutProducts, 2);
  assert.equal(row.changes.changedOffers, 3);
  assert.equal(row.changes.changedOffersWithoutAcceptedSignal, 2);
  assert.equal(row.changes.noSignalReasons.preorder_purchase_unverified, 1);
  assert.equal(row.changes.noSignalReasons["product_type:accessory"], 1);
  assert.equal(row.candidates.whisper, 1);
  assert.equal(row.candidates.manifested, 1);
  assert.equal(row.candidates.echoReadinessEvents, 2);
  assert.equal(row.canonicalSuppression.conflicts, 1);
  assert.equal(row.delivery.emittedAlerts, 1);
  assert.equal(row.delivery.suppressedAlerts, 1);
  assert.equal(row.delivery.suppressionReasons.policy_inbox_only, 1);
  assert.equal(row.health.scanFreshness, "fresh");
});
