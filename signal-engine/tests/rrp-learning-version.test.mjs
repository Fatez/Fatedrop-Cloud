import test from "node:test";
import assert from "node:assert/strict";
import { RRP_LEARNING_VERSION } from "../src/core/rrp-learning-version.mjs";
test("RRP learning contract is versioned",()=>assert.equal(RRP_LEARNING_VERSION,1));
