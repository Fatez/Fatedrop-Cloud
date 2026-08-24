import test from "node:test";
import assert from "node:assert/strict";
import { checkDiscordRouteHealth } from "../src/telemetry/discord-route-health.mjs";

function reply({ ok = true, status = 200, body = {} } = {}) {
  return { ok, status, async json() { return body; } };
}

function vanished(result) { return result.routes.find((route) => route.state === "vanished"); }

test("canonical Nyxen identity is healthy for Vanished", async () => {
  const result = await checkDiscordRouteHealth({
    enabled: true,
    botTokens: { vanished: "nyxen-token" },
    channelIds: { vanished: "444" },
    fetchImpl: async (url) => {
      if (url.endsWith("/users/@me")) return reply({ body: { username: "Nyxen" } });
      if (url.endsWith("/channels/444/typing")) return reply({ status: 204 });
      if (url.includes("/channels/444")) return reply({ body: { name: "nyxen-vanished" } });
      throw new Error(`unexpected request ${url}`);
    },
  });
  const route = vanished(result);
  assert.equal(route.ready, true);
  assert.equal(route.companion, "Nyxen");
  assert.equal(route.botUsername, "Nyxen");
  assert.equal(route.identityRepaired, false);
});

test("legacy Nixon and Nixen bot usernames remain accepted during the rename", async () => {
  for (const username of ["Nixon", "Nixen"]) {
    const result = await checkDiscordRouteHealth({
      enabled: true,
      botTokens: { vanished: "legacy-token" },
      channelIds: { vanished: "444" },
      fetchImpl: async (url) => {
        if (url.endsWith("/users/@me")) return reply({ body: { username } });
        if (url.endsWith("/channels/444/typing")) return reply({ status: 204 });
        if (url.includes("/channels/444")) return reply({ body: { name: "legacy-vanished" } });
        throw new Error(`unexpected request ${url}`);
      },
    });
    assert.equal(vanished(result).ready, true);
    assert.equal(vanished(result).companion, "Nyxen");
    assert.equal(vanished(result).botUsername, username);
  }
});

test("unrelated bot identity still fails closed", async () => {
  const result = await checkDiscordRouteHealth({
    enabled: true,
    botTokens: { vanished: "wrong-token" },
    channelIds: { vanished: "444" },
    fetchImpl: async (url) => {
      if (url.endsWith("/users/@me")) return reply({ body: { username: "SomeOtherBot" } });
      throw new Error("channel request should not occur");
    },
  });
  const route = vanished(result);
  assert.equal(route.ready, false);
  assert.equal(route.reason, "bot_identity_mismatch");
});
