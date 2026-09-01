import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("production server exposes protected signal-yield diagnostics with a bounded window", () => {
  assert.match(serverSource, /loadSignalYieldReport/);
  assert.match(serverSource, /url\.pathname === "\/api\/signal-yield"/);
  assert.match(serverSource, /Math\.max\(1, Math\.min\(24 \* 30,/);
  assert.match(serverSource, /configuredRetailers: retailers/);
  assert.match(serverSource, /globalIntervalSeconds: env\.scanIntervalSeconds/);
  assert.match(serverSource, /"cache-control": "no-store"/);
});

test("signal-yield remains inside the private diagnostic path set", () => {
  const diagnosticDeclaration = serverSource.match(/const PRIVATE_DIAGNOSTIC_PATHS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.match(diagnosticDeclaration, /\/api\/signal-yield/);
});