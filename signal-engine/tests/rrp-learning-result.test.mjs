import test from "node:test";
import assert from "node:assert/strict";
import { learningEvidence } from "../src/core/rrp-learning-result.mjs";
test("learning evidence records disposition",()=>assert.equal(learningEvidence({disposition:"queued_unknown"})[0].value,"queued_unknown"));
