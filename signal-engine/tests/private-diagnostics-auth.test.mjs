import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");

test("internal diagnostic endpoints require the service bearer token before routing", () => {
  for (const pathname of [
    "/api/status",
    "/api/discord-route-health",
    "/api/beta-readiness",
    "/api/website-snapshot-health",
    "/api/fatefind-evaluator-preflight",
    "/api/signal-health",
  ]) {
    assert.match(serverSource, new RegExp(pathname.replaceAll("/", "\\/")));
  }

  assert.match(serverSource, /PRIVATE_DIAGNOSTIC_PATHS\.has\(url\.pathname\)/);
  assert.match(serverSource, /!diagnosticAuthorized\(req\)/);
  assert.match(serverSource, /res\.writeHead\(401/);
  assert.match(serverSource, /if \(!env\.apiToken\) return false/);
  assert.match(serverSource, /timingSafeEqual/);
});

test("public retailer directory remains outside the private diagnostic gate", () => {
  const diagnosticDeclaration = serverSource.match(/const PRIVATE_DIAGNOSTIC_PATHS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.doesNotMatch(diagnosticDeclaration, /\/api\/retailers/);
});
