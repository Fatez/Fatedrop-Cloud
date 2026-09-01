import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("production server exposes only aggregate signal health on the public health route", () => {
  assert.match(serverSource, /url\.pathname === "\/api\/signal-health"/);
  assert.match(serverSource, /loadSignalHealthSummary\(store, \{ days, includeIdentityFacets: true \}\)/);
  assert.match(serverSource, /"cache-control": "no-store"/);
  assert.doesNotMatch(serverSource, /\/api\/signal-health[\s\S]{0,400}listSignals/);
});
