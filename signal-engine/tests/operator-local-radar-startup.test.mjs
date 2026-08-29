import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const productionServer = fs.readFileSync(new URL("../src/server-production.mjs", import.meta.url), "utf8");
const intake = fs.readFileSync(new URL("../src/encounters/operator-local-radar-intake.mjs", import.meta.url), "utf8");

test("production server owns lifecycle heartbeat and Local Radar operator intake", () => {
  assert.match(packageJson.scripts.start, /lifecycle-push-heartbeat\.mjs/);
  assert.match(packageJson.scripts.start, /server-production\.mjs$/);
  assert.doesNotMatch(packageJson.scripts.start, /operator-local-radar-bootstrap/);
  assert.match(productionServer, /import \{ startOperatorLocalRadarIntake \} from "\.\/encounters\/operator-local-radar-intake\.mjs"/);
  assert.match(productionServer, /const localBranchStore = createStore\(\);[\s\S]*startOperatorLocalRadarIntake\(\{ store: localBranchStore \}\)/);
});

test("operator watcher reuses the production canonical store and never owns a pg pool", () => {
  assert.match(productionServer, /startOperatorLocalRadarIntake\(\{ store: localBranchStore \}\)/);
  assert.doesNotMatch(intake, /new\s+Pool\s*\(/);
  assert.doesNotMatch(intake, /from\s+["']pg["']/);
});
