import test from "node:test";
import assert from "node:assert/strict";
import { RRP_LEARNING_STATUSES } from "../src/core/rrp-learning-status.mjs";
test("learning statuses include conflict and genuine unknown",()=>{assert.ok(RRP_LEARNING_STATUSES.includes("conflict"));assert.ok(RRP_LEARNING_STATUSES.includes("genuine_unknown"));});
