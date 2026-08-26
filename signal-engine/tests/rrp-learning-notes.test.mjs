import test from "node:test";
import assert from "node:assert/strict";
import { RRP_LEARNING_GUARDRAIL } from "../src/core/rrp-learning-notes.mjs";

test("learning guardrail forbids retailer price promotion", () => {
  assert.match(RRP_LEARNING_GUARDRAIL, /never become authoritative RRP/);
});
