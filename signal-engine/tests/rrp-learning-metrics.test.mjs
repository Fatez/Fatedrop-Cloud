import test from "node:test";
import assert from "node:assert/strict";
import { summariseRrpLearning } from "../src/core/rrp-learning-metrics.mjs";
test("summarises learning queue statuses",()=>assert.deepEqual(summariseRrpLearning([{status:"open"},{status:"resolved"}]),{total:2,open:1,candidate:0,resolved:1,genuineUnknown:0,conflict:0}));
