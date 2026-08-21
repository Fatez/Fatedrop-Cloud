import test from "node:test";
import assert from "node:assert/strict";
import { supervisorIntervalMs, supervisorProbeTimeoutMs, supervisorProbeUrl } from "../src/supervisor-runtime.mjs";

test("supervisor probes Chrome's CDP version endpoint", () => {
  assert.equal(supervisorProbeUrl("http://127.0.0.1:9222"), "http://127.0.0.1:9222/json/version");
  assert.equal(supervisorProbeUrl("http://localhost:9222/devtools/browser/foo?x=1"), "http://localhost:9222/json/version");
});

test("supervisor intervals stay bounded", () => {
  assert.equal(supervisorIntervalMs("1000"), 5000);
  assert.equal(supervisorIntervalMs("15000"), 15000);
  assert.equal(supervisorIntervalMs("bad"), 10000);
  assert.equal(supervisorProbeTimeoutMs("250"), 1000);
  assert.equal(supervisorProbeTimeoutMs("20000"), 10000);
});
