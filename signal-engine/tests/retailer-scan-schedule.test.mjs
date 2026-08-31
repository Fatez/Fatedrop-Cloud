import assert from "node:assert/strict";
import test from "node:test";
import { retailerScanScheduleDecision } from "../src/core/scan-schedule.mjs";

const now = 2_000_000_000;
const retailer = { id: "test-retailer" };

function health(lastError, elapsedSeconds = 60, healthy = false, failureCode = null) {
  return { healthy, lastError, failureCode, lastScanAt: now - elapsedSeconds };
}

test("403 access failures cool down for six hours", () => {
  const decision = retailerScanScheduleDecision(retailer, health("Retailer blocked catalogue request (403)"), { now, globalIntervalSeconds: 300 });
  assert.equal(decision.eligible, false);
  assert.equal(decision.intervalSeconds, 6 * 60 * 60);
  assert.equal(decision.reason, "retailer_failure_backoff");
  assert.equal(decision.failureClass, "access_blocked");
  assert.equal(decision.recoveryAction, "review_access_route");
});

test("structured monitor-run codes drive recovery even when error prose is missing", () => {
  const partial = retailerScanScheduleDecision(retailer, health(null, 60, false, "partial_catalogue_discovery"), { now });
  assert.equal(partial.intervalSeconds, 30 * 60);
  assert.equal(partial.failureClass, "partial_catalogue");
  assert.equal(partial.recoveryAction, "repair_catalogue_discovery");

  const empty = retailerScanScheduleDecision(retailer, health(null, 60, false, "zero_qualifying_products"), { now });
  assert.equal(empty.intervalSeconds, 60 * 60);
  assert.equal(empty.failureClass, "catalogue_empty");
  assert.equal(empty.recoveryAction, "validate_catalogue_scope");
});

test("rate limits cool down for two hours", () => {
  const decision = retailerScanScheduleDecision(retailer, health("Retailer rate-limited catalogue request (429)"), { now, globalIntervalSeconds: 300 });
  assert.equal(decision.intervalSeconds, 2 * 60 * 60);
  assert.equal(decision.eligible, false);
});

test("timeouts cool down for thirty minutes", () => {
  const decision = retailerScanScheduleDecision(retailer, health("catalogue request timed out after 30000ms"), { now, globalIntervalSeconds: 300 });
  assert.equal(decision.intervalSeconds, 30 * 60);
});

test("safety-cap and zero-product failures wait an hour instead of retrying every global cycle", () => {
  assert.equal(retailerScanScheduleDecision(retailer, health("above safety cap 1200"), { now }).intervalSeconds, 60 * 60);
  assert.equal(retailerScanScheduleDecision(retailer, health("Catalogue scan returned zero qualifying products"), { now }).intervalSeconds, 60 * 60);
});

test("healthy retailers keep the normal schedule unless a slower retailer interval is configured", () => {
  const normal = retailerScanScheduleDecision(retailer, health(null, 301, true), { now, globalIntervalSeconds: 300 });
  assert.equal(normal.eligible, true);
  const slower = retailerScanScheduleDecision({ ...retailer, scanIntervalSeconds: 900 }, health(null, 600, true), { now, globalIntervalSeconds: 300 });
  assert.equal(slower.eligible, false);
  assert.equal(slower.intervalSeconds, 900);
  assert.equal(slower.failureClass, "none");
  assert.equal(slower.recoveryAction, "normal_scan");
});

test("identity and market conflicts are classified for quarantine instead of guessed through", () => {
  const identity = retailerScanScheduleDecision(retailer, health("canonical identity resolution conflict"), { now });
  assert.equal(identity.failureClass, "identity_resolution");
  assert.equal(identity.recoveryAction, "quarantine_identity_conflict");

  const market = retailerScanScheduleDecision(retailer, health(null, 60, false, "market_conflict"), { now });
  assert.equal(market.failureClass, "market_conflict");
  assert.equal(market.recoveryAction, "quarantine_market_conflict");
});
