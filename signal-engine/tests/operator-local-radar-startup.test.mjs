import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("production starts both lifecycle heartbeat and Local Radar operator intake", () => {
  const start = packageJson.scripts.start;
  assert.match(start, /lifecycle-push-heartbeat\.mjs/);
  assert.match(start, /operator-local-radar-intake\.mjs/);
  assert.match(start, /server-production\.mjs$/);
});
