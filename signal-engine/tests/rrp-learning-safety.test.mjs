import test from "node:test";
import assert from "node:assert/strict";
import { mayPersistVerifiedAlias } from "../src/core/rrp-learning-safety.mjs";
test("only high-confidence authoritative aliases persist",()=>{
  assert.equal(mayPersistVerifiedAlias({confidence:1,authoritativeRrpPence:13499,canonicalIdentityId:"prd-1"}),true);
  assert.equal(mayPersistVerifiedAlias({confidence:.9,authoritativeRrpPence:13499,canonicalIdentityId:"prd-1"}),false);
});
