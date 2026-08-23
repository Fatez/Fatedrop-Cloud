import test from "node:test";
import assert from "node:assert/strict";
import { checkDiscordRouteHealth } from "../src/telemetry/discord-route-health.mjs";

function reply({ ok = true, status = 200, body = {} } = {}) {
  return { ok, status, async json() { return body; } };
}

function vanished(result) { return result.routes.find((route) => route.state === "vanished"); }

test("known Nixen typo self-heals to canonical Nixon before channel verification", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body || null });
    if (url.endsWith("/users/@me") && (options.method || "GET") === "GET") return reply({ body: { username: "Nixen" } });
    if (url.endsWith("/users/@me") && options.method === "PATCH") {
      assert.deepEqual(JSON.parse(options.body), { username: "Nixon" });
      return reply({ body: { username: "Nixon" } });
    }
    if (url.includes("/channels/444") && !url.endsWith("/typing")) return reply({ body: { name: "nixon-vanished" } });
    if (url.endsWith("/channels/444/typing")) return reply({ status: 204 });
    throw new Error(`unexpected request ${url}`);
  };

  const result = await checkDiscordRouteHealth({
    fetchImpl,
    enabled: true,
    botTokens: { vanished: "nixon-token" },
    channelIds: { vanished: "444" },
  });
  const route = vanished(result);
  assert.equal(route.ready, true);
  assert.equal(route.companion, "Nixon");
  assert.equal(route.botUsername, "Nixon");
  assert.equal(route.identityRepaired, true);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("unknown Nixon identity mismatch is never renamed automatically", async () => {
  let patches = 0;
  const result = await checkDiscordRouteHealth({
    enabled: true,
    botTokens: { vanished: "wrong-token" },
    channelIds: { vanished: "444" },
    fetchImpl: async (url, options = {}) => {
      if (options.method === "PATCH") patches += 1;
      if (url.endsWith("/users/@me")) return reply({ body: { username: "SomeOtherBot" } });
      throw new Error("channel request should not occur");
    },
  });
  const route = vanished(result);
  assert.equal(route.ready, false);
  assert.equal(route.reason, "bot_identity_mismatch");
  assert.equal(patches, 0);
});
