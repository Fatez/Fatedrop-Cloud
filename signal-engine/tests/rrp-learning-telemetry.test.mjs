import test from "node:test";
import assert from "node:assert/strict";
import { rrpLearningTelemetry } from "../src/core/rrp-learning-telemetry.mjs";

test("RRP learning telemetry is explicit", () => {
  assert.deepEqual(rrpLearningTelemetry({ disposition: "queued_unknown", retailerId: "x", title: "y", productType: "booster_box" }), { disposition: "queued_unknown", retailerId: "x", title: "y", productType: "booster_box" });
});
