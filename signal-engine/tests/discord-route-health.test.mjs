import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCORD_ROUTE_HEALTH_STATES,
  probeDiscordRoute,
  refreshDiscordRouteHealth,
} from "../src/notifications/discord-route-health.mjs";

function reply({ ok = true, status = 200, body = {} } = {}) {
  return {
    ok,
    status,
    async json() { return body; },
  };
}

test("all four dedicated companion routes can be verified without sending a persistent message", async () => {
  const botTokens = {
    whisper: "oru-secret-token",
    echo: "fenn-secret-token",
    manifested: "koru-secret-token",
    vanished: "nixon-secret-token",
  };
  const channelIds = {
    whisper: "111",
    echo: "222",
    manifested: "333",
    vanished: "444",
  };
  const usernameByToken = {
    "oru-secret-token": "Oru",
    "fenn-secret-token": "Fenn",
    "koru-secret-token": "Koru",
    "nixon-secret-token": "Nixon",
  };
  const channelById = {
    "111": "oru-whispers",
    "222": "fenn-echoes",
    "333": "koru-manifested",
    "444": "nixon-vanished",
  };
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", authorization: options.headers?.Authorization });
    const token = String(options.headers?.Authorization || "").replace(/^Bot /, "");
    if (url.endsWith("/users/@me")) return reply({ body: { id: `bot-${usernameByToken[token]}`, username: usernameByToken[token] } });
    const channelId = url.match(/\/channels\/(\d+)/)?.[1];
    if (url.endsWith("/typing")) return reply({ status: 204 });
    return reply({ body: { id: channelId, name: channelById[channelId] } });
  };

  const result = await refreshDiscordRouteHealth({ fetchImpl, enabled: true, botTokens, channelIds });
  assert.equal(result.healthy, true);
  assert.deepEqual(DISCORD_ROUTE_HEALTH_STATES, ["whisper", "echo", "manifested", "vanished"]);
  assert.equal(result.routes.whisper.companion, "Oru");
  assert.equal(result.routes.whisper.botUsername, "Oru");
  assert.equal(result.routes.whisper.channelName, "oru-whispers");
  assert.equal(result.routes.echo.companion, "Fenn");
  assert.equal(result.routes.echo.botUsername, "Fenn");
  assert.equal(result.routes.echo.channelName, "fenn-echoes");
  assert.equal(result.routes.manifested.botUsername, "Koru");
  assert.equal(result.routes.vanished.botUsername, "Nixon");
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/typing")).length, 4);

  const publicSnapshot = JSON.stringify(result);
  for (const token of Object.values(botTokens)) assert.equal(publicSnapshot.includes(token), false);
  for (const channelId of Object.values(channelIds)) assert.equal(publicSnapshot.includes(`\"${channelId}\"`), false);
});

test("route health requires a dedicated companion token even while legacy delivery fallback still exists", async () => {
  let calls = 0;
  const result = await probeDiscordRoute("echo", {
    fetchImpl: async () => { calls += 1; return reply(); },
    enabled: true,
    botTokens: {},
    channelIds: { echo: "222" },
  });
  assert.equal(calls, 0);
  assert.equal(result.healthy, false);
  assert.equal(result.configured, false);
  assert.equal(result.reason, "missing_dedicated_bot_token");
});

test("route health fails closed when the bot cannot interact with its lifecycle channel", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/users/@me")) return reply({ body: { id: "bot-fenn", username: "Fenn" } });
    if (url.endsWith("/typing")) return reply({ ok: false, status: 403 });
    return reply({ body: { id: "222", name: "fenn-echoes" } });
  };
  const result = await probeDiscordRoute("echo", {
    fetchImpl,
    enabled: true,
    botTokens: { echo: "fenn-secret-token" },
    channelIds: { echo: "222" },
  });
  assert.equal(result.healthy, false);
  assert.equal(result.configured, true);
  assert.equal(result.reason, "send_permission_failed");
  assert.equal(result.httpStatus, 403);
  assert.equal(result.botUsername, "Fenn");
  assert.equal(result.channelName, "fenn-echoes");
});
