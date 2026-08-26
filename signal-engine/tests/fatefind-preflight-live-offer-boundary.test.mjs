import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/telemetry/fatefind-evaluator-preflight.mjs", import.meta.url), "utf8");

test("FateFind evaluator preflight only samples healthy fresh retailer offers", () => {
  assert.match(source, /JOIN fatedrop_retailer_health rh ON rh\.retailer_id=o\.retailer_id/);
  assert.match(source, /rh\.healthy=true/);
  assert.match(source, /COALESCE\(rh\.last_success_at,rh\.last_scan_at\)/);
  assert.match(source, /- 1800/);
});
