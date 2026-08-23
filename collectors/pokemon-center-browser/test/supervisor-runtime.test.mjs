import test from "node:test";
import assert from "node:assert/strict";
import { supervisorAccessCooldownMs, supervisorIntervalMs, supervisorProbeTimeoutMs, supervisorProbeUrl, supervisorRestartDelayMs } from "../src/supervisor-runtime.mjs";

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

test("collector restart delay grows exponentially but remains capped", () => {
  assert.equal(supervisorRestartDelayMs(0), 60_000);
  assert.equal(supervisorRestartDelayMs(1), 120_000);
  assert.equal(supervisorRestartDelayMs(4), 960_000);
  assert.equal(supervisorRestartDelayMs(10), 1_800_000);
});

test("retailer readiness cooldowns fail closed to conservative minimums", () => {
  assert.equal(supervisorAccessCooldownMs("queue"), 300_000);
  assert.equal(supervisorAccessCooldownMs("security"), 900_000);
  assert.equal(supervisorAccessCooldownMs("access_blocked"), 3_600_000);
  assert.equal(supervisorAccessCooldownMs("queue", { queue: 30_000 }), 120_000);
  assert.equal(supervisorAccessCooldownMs("security", { security: 60_000 }), 300_000);
  assert.equal(supervisorAccessCooldownMs("access_blocked", { access_blocked: 60_000 }), 900_000);
});
