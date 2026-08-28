import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const recurringPaths = [
  "../src/hosted/run.mjs",
  "../src/retailers/runtime.mjs",
  "../src/retailers/candidate-qualification.mjs",
  "../src/rrp/asmodee-bootstrap.mjs",
  "../src/rrp-sync-asmodee.mjs",
  "../src/server-production.mjs",
];

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("recurring production database paths do not create private pg pools", async () => {
  for (const path of recurringPaths) {
    const code = await source(path);
    assert.doesNotMatch(code, /\bnew\s+Pool\s*\(/, `${path} must not create a private pg Pool`);
    assert.doesNotMatch(code, /from\s+["']pg["']/, `${path} must not import pg directly`);
    assert.doesNotMatch(code, /import\s*\(\s*["']pg["']\s*\)/, `${path} must not import pg dynamically`);
  }
});

test("production entrypoints explicitly route recurring database work through the canonical store", async () => {
  const server = await source("../src/server.mjs");
  const production = await source("../src/server-production.mjs");
  const hosted = await source("../src/hosted/run.mjs");
  const rrp = await source("../src/rrp/asmodee-bootstrap.mjs");

  assert.match(server, /const store = createStore\(\)/);
  assert.match(server, /loadRuntimeRetailers\(\{[\s\S]*?store,[\s\S]*?\}\)/);
  assert.match(production, /const localBranchStore = createStore\(\)/);
  assert.match(production, /runCandidateQualificationCycle\(\{[^}]*store: localBranchStore[^}]*\}\)/);
  assert.match(hosted, /const store = createStore\(\)/);
  assert.match(hosted, /return store\.pool\(\)/);
  assert.match(rrp, /const pool = await store\.pool\(\)/);
  assert.match(rrp, /syncFn\(\{ databaseUrl, pool, now \}\)/);
});
