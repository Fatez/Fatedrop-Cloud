import test from "node:test";
import assert from "node:assert/strict";
import { rrpLearningDisposition } from "../src/core/rrp-learning-policy.mjs";

test("RRP learning disposition prioritises remembered resolution", () => {
  assert.equal(rrpLearningDisposition({ rrpResolved: true, rememberedAlias: true }), "resolved_from_memory");
  assert.equal(rrpLearningDisposition({ queuedUnknown: true }), "queued_unknown");
  assert.equal(rrpLearningDisposition({ conflict: true, queuedUnknown: true }), "conflict");
});
