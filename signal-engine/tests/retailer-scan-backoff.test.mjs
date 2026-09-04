import assert from "node:assert/strict";
import test from "node:test";

import { retailerFailureBackoffDecision } from "../src/core/retailer-scan-backoff.mjs";

const retailer = { id: "example-uk" };

test("healthy retailers are never deferred", () => {
  const decision = retailerFailureBackoffDecision({
    retailer,
    health: { healthy: true, lastScanAt: 1000, failureCode: null, lastError: null },
    now: 2000,
  });
  assert.equal(decision.defer, false);
  assert.equal(decision.retryAt, null);
});

test("access-blocked retailers respect the canonical six-hour failure backoff", () => {
  const decision = retailerFailureBackoffDecision({
    retailer,
    health: {
      healthy: false,
      lastScanAt: 1000,
      failureCode: "retailer_access_blocked",
      lastError: "catalogue request failed (403)",
    },
    now: 1000 + (5 * 60 * 60),
  });
  assert.equal(decision.defer, true);
  assert.equal(decision.failureClass, "access_blocked");
  assert.equal(decision.backoffSeconds, 6 * 60 * 60);
  assert.equal(decision.retryAt, 1000 + (6 * 60 * 60));
});

test("access-blocked retailers become due again after the backoff expires", () => {
  const retryAt = 1000 + (6 * 60 * 60);
  const decision = retailerFailureBackoffDecision({
    retailer,
    health: {
      healthy: false,
      lastScanAt: 1000,
      failureCode: "retailer_access_blocked",
      lastError: "catalogue request failed (403)",
    },
    now: retryAt,
  });
  assert.equal(decision.defer, false);
  assert.equal(decision.retryAt, retryAt);
});

test("ordinary scan exceptions keep the shorter unknown-failure retry window", () => {
  const decision = retailerFailureBackoffDecision({
    retailer,
    health: {
      healthy: false,
      lastScanAt: 1000,
      failureCode: "scan_exception",
      lastError: "catalogue request failed (404)",
    },
    now: 1000 + (10 * 60),
  });
  assert.equal(decision.defer, true);
  assert.equal(decision.failureClass, "unknown");
  assert.equal(decision.backoffSeconds, 15 * 60);
});
