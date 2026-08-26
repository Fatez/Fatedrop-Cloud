import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");

test("public FateFind preflight is cached and concurrent refreshes are coalesced", () => {
  assert.match(source, /FATEFIND_PREFLIGHT_CACHE_MS = 60 \* 1000/);
  assert.match(source, /if \(fateFindPreflightCache && now - fateFindPreflightCachedAt < FATEFIND_PREFLIGHT_CACHE_MS\)/);
  assert.match(source, /if \(fateFindPreflightInFlight\) return fateFindPreflightInFlight/);
  assert.match(source, /const summary = await cachedFateFindEvaluatorPreflight\(\)/);
  assert.doesNotMatch(source, /url\.pathname === "\/api\/fatefind-evaluator-preflight"[\s\S]{0,120}buildFateFindEvaluatorPreflight\(store\)/);
});
