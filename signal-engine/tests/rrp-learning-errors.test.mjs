import test from "node:test";
import assert from "node:assert/strict";
import { RRP_FAILURE_REASONS } from "../src/core/rrp-learning-errors.mjs";

test("RRP failure reasons are stable telemetry values", () => {
  assert.equal(RRP_FAILURE_REASONS.NO_VERIFIED_REFERENCE, "no_verified_rrp_reference");
});
