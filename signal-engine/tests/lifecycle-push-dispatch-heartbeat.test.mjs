import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { lifecyclePushDispatchConfig, triggerLifecyclePushDispatch } from "../src/notifications/lifecycle-push-dispatch.mjs";

const heartbeatSource = fs.readFileSync(new URL("../src/notifications/lifecycle-push-heartbeat.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("push heartbeat is inert outside configured production", () => {
  assert.deepEqual(lifecyclePushDispatchConfig({ environmentName: "development", store: "file", databaseUrl: "", secret: "" }), {
    configured: false,
    url: "",
    secret: "",
  });
});

test("production Postgres defaults to the canonical FateDrop Web dispatch route", () => {
  const config = lifecyclePushDispatchConfig({
    environmentName: "production",
    store: "postgres",
    databaseUrl: "postgres://example.invalid/db",
    secret: "shared-secret",
  });
  assert.equal(config.configured, true);
  assert.equal(config.url, "https://fatedrop.co.uk/api/dashboard/push-dispatch");
  assert.equal(config.secret, "shared-secret");
});

test("Cloud calls Web with the existing shared server secret and no arbitrary payload", async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() { return { accepted: true, queued: 1, claimed: 1, sent: 1, failed: 0 }; },
    };
  };
  const result = await triggerLifecyclePushDispatch({
    fetchImpl,
    config: { configured: true, url: "https://example.test/api/dashboard/push-dispatch", secret: "shared-secret" },
  });
  assert.equal(result.triggered, true);
  assert.equal(request.url, "https://example.test/api/dashboard/push-dispatch");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer shared-secret");
  assert.equal("body" in request.options, false);
});

test("Web failure is reported without throwing into the signal engine", async () => {
  const result = await triggerLifecyclePushDispatch({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() { return { error: "Push dispatch is not enabled." }; },
    }),
    config: { configured: true, url: "https://example.test/api/dashboard/push-dispatch", secret: "shared-secret" },
  });
  assert.equal(result.configured, true);
  assert.equal(result.triggered, false);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.error, "Push dispatch is not enabled.");
});

test("production start wires an isolated one-minute heartbeat", () => {
  assert.equal(packageJson.scripts.start, "node --import ./src/notifications/lifecycle-push-heartbeat.mjs src/server-production.mjs");
  assert.match(heartbeatSource, /60 \* 1000/);
  assert.match(heartbeatSource, /dispatch_in_progress/);
  assert.match(heartbeatSource, /setInterval\(runLifecyclePushDispatchHeartbeat/);
});
