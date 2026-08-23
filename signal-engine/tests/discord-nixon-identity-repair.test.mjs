import test from "node:test";
import assert from "node:assert/strict";
import { checkDiscordRouteHealth } from "../src/telemetry/discord-route-health.mjs";

function response({ ok = true, status = 200, body = {} } = {}) {
  return { ok, status, async json() { return body; } };
}

function vanished(result) {
  return result.routes.find((route) => route.state === "vanished");
}

test("known Nixen typo is repaired to canonical Nixon before route verification continues", async () => {
  const calls = [];
  let identityReads = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body || null });
    if (url.endsWith("/users/@me") && (options.method || "GET") === "GET") {
      identityReads += 1;
      return response({ body: { username: identityReads === 1 ? "Nixen" : "Nixon" } });
    }
    if (url.endsWith("/users/@me") && options.method === "PATCH") return response({ body: { username: "Nixon" } });
    if (url.includes("/channels/444") && !url.endsWith("/typing")) return response({ body: { name: "🔮・nixon-vanished" } });
    if (url.endsWith("/channels/444/typing")) return response({ status: 204 });
    throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
  };

  const result = await checkDiscordRouteHealth({
    fetchImpl,
    enabled: true,
    botTokens: { vanished: "nixon-token" },
    channelIds: { vanished: "444" },
    now: () => Date.parse("2026-08-23T23:00:00.000Z"),
  });
  const route = vanished(result);
  assert.equal(route.ready, true);
  assert.equal(route.botUsername, "Nixon");
  assert.equal(route.channelName, "🔮・nixon-vanished");
  assert.equal(route.identityRepaired, true);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch);
  assert.deepEqual(JSON.parse(patch.body), { username: "Nixon" });
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("identity repair is limited to the exact known Nixen typo", async () => {
  const calls = [];
  const result = await checkDiscordRouteHealth({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      if (url.endsWith("/users/@me")) return response({ body: { username: "SomethingElse" } });
      throw new Error("No repair or channel request should run for an unknown identity mismatch");
    },
    enabled: true,
    botTokens: { vanished: "wrong-token" },
    channelIds: { vanished: "444" },
  });
  const route = vanished(result);
  assert.equal(route.ready, false);
  assert.equal(route.reason, "bot_identity_mismatch");
  assert.equal(route.identityRepaired, false);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
});

test("Discord refusing the rename fails closed and does not probe the channel", async () => {
  const calls = [];
  const result = await checkDiscordRouteHealth({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      if (url.endsWith("/users/@me") && (options.method || "GET") === "GET") return response({ body: { username: "Nixen" } });
      if (url.endsWith("/users/@me") && options.method === "PATCH") return response({ ok: false, status: 429 });
      throw new Error("Channel probe should not run when the identity repair failed");
    },
    enabled: true,
    botTokens: { vanished: "nixon-token" },
    channelIds: { vanished: "444" },
  });
  const route = vanished(result);
  assert.equal(route.ready, false);
  assert.equal(route.reason, "discord_identity_repair_http_429");
  assert.equal(calls.some((call) => call.url.includes("/channels/444")), false);
});
