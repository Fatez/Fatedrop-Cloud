import test from "node:test";
import assert from "node:assert/strict";

import { classifyRetailerFailure } from "../src/core/retailer-failure-classification.mjs";

test("catalogue 404 is a configuration failure with six-hour backoff", () => {
  const result = classifyRetailerFailure({
    failureCode: "scan_exception",
    lastError: "catalogue request failed (404)",
  });

  assert.equal(result.failureClass, "configuration");
  assert.equal(result.backoffSeconds, 6 * 60 * 60);
  assert.equal(result.recoveryAction, "repair_configuration");
});

test("structured catalogue 404 is also configuration failure", () => {
  const result = classifyRetailerFailure({
    failureCode: "scan_exception",
    lastError: "structured catalogue request failed (404)",
  });

  assert.equal(result.failureClass, "configuration");
  assert.equal(result.backoffSeconds, 6 * 60 * 60);
});
