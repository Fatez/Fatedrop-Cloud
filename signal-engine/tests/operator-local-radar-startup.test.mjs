import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bootstrap = fs.readFileSync(new URL("../src/encounters/operator-local-radar-bootstrap.mjs", import.meta.url), "utf8");
const intake = fs.readFileSync(new URL("../src/encounters/operator-local-radar-intake.mjs", import.meta.url), "utf8");

test("production starts lifecycle heartbeat and Local Radar operator intake", () => {
  const start = packageJson.scripts.start;
  assert.match(start, /lifecycle-push-heartbeat\.mjs/);
  assert.match(start, /operator-local-radar-bootstrap\.mjs/);
  assert.match(start, /server-production\.mjs$/);
});

test("operator watcher reuses canonical createStore singleton and never owns a pg pool", () => {
  assert.match(bootstrap, /createStore\(\)/);
  assert.match(bootstrap, /startOperatorLocalRadarIntake\(\{ store \}\)/);
  assert.doesNotMatch(intake, /new\s+Pool\s*\(/);
  assert.doesNotMatch(intake, /from\s+["']pg["']/);
});
