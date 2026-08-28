import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRrpGapSnapshot,
  classifyRrpGap,
  currentRrpObservationFingerprint,
  rankRrpGapRows,
  rrpGapPriority,
} from "../src/core/rrp-gap-intelligence.mjs";

const now = 1_787_950_000;

test("RRP knowledge gaps are classified into safe action families", () => {
  assert.equal(classifyRrpGap("no_authoritative_candidate").classification, "authority_gap");
  assert.equal(classifyRrpGap("no_exact_identity_match").classification, "identity_gap");
  assert.equal(classifyRrpGap("conflicting_verified_rrp").classification, "authority_conflict");
  assert.equal(classifyRrpGap("no_verified_pack_reference").classification, "component_authority_gap");
});

test("live repeated high-value gaps outrank stale low-value unknowns", () => {
  const liveEtb = {
    id: "q-live",
    product_id: "prd-etb",
    retailer_id: "titan-cards",
    observed_title: "Mega Evolution Elite Trainer Box - Mega Lucario",
    product_type: "elite_trainer_box",
    failure_reason: "no_authoritative_candidate",
    occurrence_count: 8,
    last_seen_at: now - 60,
    evidence_json: { stock_status: "in_stock", live_offer: true, price_pence: 11395, retailer_sku: "SKU-ETB" },
  };
  const staleOther = {
    id: "q-stale",
    retailer_id: "old-shop",
    observed_title: "Unknown sealed thing",
    product_type: "other",
    failure_reason: "verified_rrp_unavailable",
    occurrence_count: 1,
    last_seen_at: now - (10 * 86400),
    evidence_json: {},
  };
  assert.ok(rrpGapPriority(liveEtb, { now }) > rrpGapPriority(staleOther, { now }));
});

test("multi-retailer recurrence becomes stronger knowledge evidence", () => {
  const rows = [
    {
      id: "q-1", product_id: "prd-etb", retailer_id: "titan-cards", observed_title: "Mega Lucario ETB",
      product_type: "elite_trainer_box", failure_reason: "no_exact_identity_match", occurrence_count: 2, last_seen_at: now,
      evidence_json: { stock_status: "in_stock", retailer_sku: "a" },
    },
    {
      id: "q-2", product_id: "prd-etb", retailer_id: "chaos-cards", observed_title: "Mega Lucario ETB",
      product_type: "elite_trainer_box", failure_reason: "no_exact_identity_match", occurrence_count: 2, last_seen_at: now,
      evidence_json: { stock_status: "in_stock", retailer_sku: "b" },
    },
  ];
  const ranked = rankRrpGapRows(rows, { now });
  assert.equal(ranked[0].intelligence.crossRetailerCount, 2);
  assert.ok(ranked[0].intelligence.priority >= 60);
});

test("observation fingerprints remain stable until market evidence changes", () => {
  const row = {
    product_id: "prd-1", offer_id: "off-1", failure_reason: "no_authoritative_candidate",
    evidence_json: { stock_status: "in_stock", price_pence: 1000, retailer_sku: "sku" },
  };
  const first = currentRrpObservationFingerprint(row);
  const same = currentRrpObservationFingerprint({ ...row, occurrence_count: 50, last_seen_at: now });
  const changed = currentRrpObservationFingerprint({ ...row, evidence_json: { ...row.evidence_json, price_pence: 1200 } });
  assert.equal(first, same);
  assert.notEqual(first, changed);
});

test("knowledge snapshot surfaces live and high-priority gaps", () => {
  const snapshot = buildRrpGapSnapshot([{
    id: "q-live", product_id: "prd-etb", retailer_id: "titan-cards", observed_title: "Mega Lucario ETB",
    product_type: "elite_trainer_box", failure_reason: "no_authoritative_candidate", occurrence_count: 10, last_seen_at: now,
    evidence_json: { stock_status: "in_stock", live_offer: true, gtin: "123", retailer_sku: "sku" },
  }], { now });
  assert.equal(snapshot.openRows, 1);
  assert.equal(snapshot.liveOpen, 1);
  assert.equal(snapshot.highPriorityOpen, 1);
  assert.equal(snapshot.byClass.authority_gap, 1);
  assert.equal(snapshot.topGaps[0].retailerId, "titan-cards");
});
