import test from "node:test";
import assert from "node:assert/strict";
import {
  RETAILER_FAILURE_COOLDOWNS,
  retailerFailureClass,
  retailerCooldownDecision,
  selectRetailersForScan,
} from "../src/retailers/scan-cooldown.mjs";

const retailer = { id: "example", name: "Example", enabled: true };

test("classifies access blocks and safety failures conservatively", () => {
  assert.equal(retailerFailureClass("Retailer blocked catalogue request (403); adapter disabled for this scan — FateDrop will not bypass access controls."), "access_blocked");
  assert.equal(retailerFailureClass("BigCommerce product sitemap returned 2120 qualifying URLs, above safety cap 1200"), "safety_cap");
  assert.equal(retailerFailureClass("Catalogue scan returned zero qualifying products"), "zero_catalogue");
  assert.equal(retailerFailureClass("catalogue request timed out after 30000ms"), "timeout");
});

test("a recently 403-blocked source is held for six hours instead of retried every scan", () => {
  const now = 1_000_000;
  const decision = retailerCooldownDecision(retailer, { healthy: false, lastError: "blocked catalogue request (403)", lastScanAt: now - 300 }, { now });
  assert.equal(decision.scan, false);
  assert.equal(decision.reason, "cooldown:access_blocked");
  assert.equal(decision.retryAt, now - 300 + RETAILER_FAILURE_COOLDOWNS.access_blocked);
});

test("healthy retailers remain on normal scan cadence", () => {
  const decision = retailerCooldownDecision(retailer, { healthy: true, lastError: null, lastScanAt: 999_000 }, { now: 1_000_000 });
  assert.equal(decision.scan, true);
});

test("failed retailer becomes eligible again after its cooldown expires", () => {
  const now = 1_000_000;
  const decision = retailerCooldownDecision(retailer, { healthy: false, lastError: "catalogue request timed out after 30000ms", lastScanAt: now - 2_000 }, { now });
  assert.equal(decision.scan, true);
  assert.equal(decision.failureClass, "timeout");
});

test("scan selection holds failed retailers but never drops healthy ones", () => {
  const now = 1_000_000;
  const retailers = [
    { id: "healthy", name: "Healthy", enabled: true },
    { id: "blocked", name: "Blocked", enabled: true },
    { id: "timeout", name: "Timeout", enabled: true },
  ];
  const health = [
    { id: "healthy", healthy: true, lastScanAt: now - 100, lastError: null },
    { id: "blocked", healthy: false, lastScanAt: now - 100, lastError: "blocked catalogue request (403)" },
    { id: "timeout", healthy: false, lastScanAt: now - 100, lastError: "catalogue request timed out after 30000ms" },
  ];
  const result = selectRetailersForScan(retailers, health, { now });
  assert.deepEqual(result.active.map((item) => item.id), ["healthy"]);
  assert.deepEqual(result.held.map((item) => item.retailerId), ["blocked", "timeout"]);
});
