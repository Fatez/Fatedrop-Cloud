import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
const hostedRunSource = await readFile(new URL("../src/hosted/run.mjs", import.meta.url), "utf8");

test("instant FateFind endpoint is POST-only and authorizes before evaluation", () => {
  const privateDeclaration = serverSource.match(/const PRIVATE_DIAGNOSTIC_PATHS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.doesNotMatch(privateDeclaration, /\/internal\/fatefind\/evaluate/);
  assert.match(serverSource, /req\.method === "POST" && url\.pathname === "\/internal\/fatefind\/evaluate"/);
  assert.match(serverSource, /readJsonBody\(req\)/);
  assert.match(serverSource, /fateFindId\.length > 128/);
  assert.match(serverSource, /let authorized = diagnosticAuthorized\(req\)/);
  assert.match(serverSource, /consumeFateFindEvaluationCapability\(store, \{[\s\S]*fateFindId,[\s\S]*token: bearerToken\(req\)/);
  assert.match(serverSource, /if \(!authorized\) \{[\s\S]*res\.writeHead\(401/);
  const authIndex = serverSource.indexOf("consumeFateFindEvaluationCapability(store");
  const runIndex = serverSource.indexOf("runHostedFateFindNow(fateFindId)");
  assert.ok(authIndex >= 0 && runIndex > authIndex, "capability auth must complete before targeted evaluation");
});

test("instant FateFind evaluation reuses the canonical store and targeted hosted evaluator", () => {
  assert.match(hostedRunSource, /const store = createStore\(\)/);
  assert.match(hostedRunSource, /return store\.pool\(\)/);
  assert.doesNotMatch(hostedRunSource, /\bnew\s+Pool\s*\(/);
  assert.doesNotMatch(hostedRunSource, /from\s+["']pg["']/);
  assert.match(hostedRunSource, /evaluateHostedFateFinds\(database, \{ limit: 1, fateFindId: requestedFateFindId \}\)/);
});
