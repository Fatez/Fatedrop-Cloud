import test from "node:test";
import assert from "node:assert/strict";
import { unresolvedRrpPriority } from "../src/core/rrp-learning-priority.mjs";
test("repeat high-value unknowns rise in triage",()=>assert.ok(unresolvedRrpPriority({occurrenceCount:3,productType:"booster_box",hasAuthoritativeCandidate:true})>unresolvedRrpPriority({occurrenceCount:1,productType:"other"})));
