import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCORD_ROUTE_HEALTH_STATES,
  checkDiscordRouteHealth,
  getDiscordRouteHealth,
  refreshDiscordRouteHealth,
} from "../src/telemetry/discord-route-health.mjs";

function reply({ ok = true, status = 200, body = {} } = {}) {
  return { ok, status, async json() { return body; } };
}

function route(result, state) {
  return result.routes.find((item) => item.state === state);
}

test("all four dedicated companion routes can be verified without sending a persistent message", async () => {
  const botTokens = { whisper: "oru-secret-token", echo: "fenn-secret-token", manifested: "koru-secret-token", vanished: "nyxen-secret-token" };
  const channelIds = { whisper: "111", echo: "222", manifested: "333", vanished: "444" };
  const usernameByToken = { "oru-secret-token": "Oru", "fenn-secret-token": "Fenn", "koru-secret-token": "Koru", "nyxen-secret-token": "Nyxen" };
  const channelById = { "111": "oru-whispers", "222": "fenn-echoes", "333": "koru-manifested", "444": "nyxen-vanished" };
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
  assert.equal(result.ready, true);
  assert.deepEqual(DISCORD_ROUTE_HEALTH_STATES, ["whisper", "echo", "manifested", "vanished"]);
  assert.equal(route(result, "whisper").companion, "Oru");
  assert.equal(route(result, "whisper").botUsername, "Oru");
  assert.equal(route(result, "whisper").channelName, "oru-whispers");
  assert.equal(route(result, "echo").companion, "Fenn");
  assert.equal(route(result, "echo").botUsername, "Fenn");
  assert.equal(route(result, "echo").channelName, "fenn-echoes");
  assert.equal(route(result, "manifested").botUsername, "Koru");
  assert.equal(route(result, "vanished").botUsername, "Nyxen");
  assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/typing")).length, 4);
  assert.deepEqual(getDiscordRouteHealth(), result);

  const publicSnapshot = JSON.stringify(result);
  for (const token of Object.values(botTokens)) assert.equal(publicSnapshot.includes(token), false);
  for (const channelId of Object.values(channelIds)) assert.equal(publicSnapshot.includes(`\"${channelId}\"`), false);
});

test("route health requires a dedicated companion token even while ordinary delivery still has legacy fallback", async () => {
  let calls = 0;
  const result = await checkDiscordRouteHealth({
    fetchImpl: async () => { calls += 1; return reply(); },
    enabled: true,
    botTokens: {},
    channelIds: { echo: "222" },
  });
  const echo = route(result, "echo");
  assert.equal(calls, 0);
  assert.equal(echo.ready, false);
  assert.equal(echo.configured, false);
  assert.equal(echo.reason, "missing_dedicated_bot_token");
});

test("route health rejects a valid token wired to the wrong companion", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/users/@me")) return reply({ body: { id: "bot-oru", username: "Oru" } });
    throw new Error("channel probe should not run after identity mismatch");
  };
  const result = await checkDiscordRouteHealth({
    fetchImpl,
    enabled: true,
    botTokens: { echo: "oru-token-in-fenn-slot" },
    channelIds: { echo: "222" },
  });
  const echo = route(result, "echo");
  assert.equal(calls.length, 1);
  assert.equal(echo.ready, false);
  assert.equal(echo.configured, true);
  assert.equal(echo.reason, "bot_identity_mismatch");
  assert.equal(echo.botUsername, "Oru");
});

test("route health fails closed when the bot cannot interact with its lifecycle channel", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/users/@me")) return reply({ body: { id: "bot-fenn", username: "Fenn" } });
    if (url.endsWith("/typing")) return reply({ ok: false, status: 403 });
    if (url.includes("/channels/222")) return reply({ body: { id: "222", name: "fenn-echoes" } });
    throw new Error("unexpected route");
  };
  const result = await checkDiscordRouteHealth({
    fetchImpl,
    enabled: true,
    botTokens: { echo: "fenn-secret-token" },
    channelIds: { echo: "222" },
  });
  const echo = route(result, "echo");
  assert.equal(echo.ready, false);
  assert.equal(echo.configured, true);
  assert.equal(echo.reason, "discord_channel_send_http_403");
  assert.equal(echo.botUsername, "Fenn");
  assert.equal(echo.channelName, "fenn-echoes");
});
