import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("product discovery watch evidence reconciliation runs independently of retailer scans", () => {
  assert.match(serverSource, /reconcileProductDiscoveryWatch/);
  assert.match(serverSource, /DISCOVERY_WATCH_RECONCILE_INTERVAL_MS = 60 \* 1000/);
  assert.match(serverSource, /void reconcileDiscoveryWatchEvidence\(\)/);
  assert.match(serverSource, /setInterval\(reconcileDiscoveryWatchEvidence, DISCOVERY_WATCH_RECONCILE_INTERVAL_MS\)/);
  assert.match(serverSource, /publishWebsiteSnapshot\(\{ store \}\)/);
});

test("Drop Watch bridge does not import or modify the Pokémon Center browser collector", () => {
  assert.doesNotMatch(serverSource, /collectors\/pokemon-center-browser/);
});
