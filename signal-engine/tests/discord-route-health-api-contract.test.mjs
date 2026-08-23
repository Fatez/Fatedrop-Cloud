import test from "node:test";
import assert from "node:assert/strict";
import { refreshDiscordRouteHealth } from "../src/notifications/discord-route-health.mjs";

function response({ ok = true, status = 200, body = {} } = {}) {
  return { ok, status, async json() { return body; } };
}

test("route-health response contains names/status only, never token or channel identifiers", async () => {
  const secret = "very-secret-fenn-token";
  const channelId = "123456789";
  const result = await refreshDiscordRouteHealth({
    enabled: true,
    botTokens: { echo: secret },
    channelIds: { echo: channelId },
    fetchImpl: async (url) => {
      if (url.endsWith("/users/@me")) return response({ body: { username: "Fenn" } });
      if (url.endsWith("/typing")) return response({ status: 204 });
      return response({ body: { name: "fenn-echoes" } });
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(channelId), false);
  assert.match(serialized, /Fenn/);
  assert.match(serialized, /fenn-echoes/);
});
