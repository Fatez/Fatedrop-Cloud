import { env } from "../config/env.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const ROUTES = Object.freeze([
  { state: "whisper", companion: "Oru" },
  { state: "echo", companion: "Fenn" },
  { state: "manifested", companion: "Koru" },
  { state: "vanished", companion: "Nixon" },
]);

function normalizedIdentity(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function safeReason(prefix, response) {
  const status = Number(response?.status);
  return Number.isFinite(status) ? `${prefix}_${status}` : prefix;
}

async function botIdentity(fetchImpl, token) {
  const response = await fetchImpl(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!response?.ok) return { ok: false, reason: safeReason("discord_identity_http", response) };
  const payload = await response.json().catch(() => ({}));
  const username = String(payload?.username || payload?.global_name || "").trim();
  if (!username) return { ok: false, reason: "discord_identity_missing_username" };
  return { ok: true, username };
}

async function proveChannelSendAccess(fetchImpl, token, channelId) {
  const response = await fetchImpl(`${DISCORD_API}/channels/${channelId}/typing`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
  });
  if (response?.ok || response?.status === 204) return { ok: true };
  return { ok: false, reason: safeReason("discord_channel_http", response) };
}

export function emptyDiscordRouteHealth({ enabled = env.discord.enabled, now = () => Date.now() } = {}) {
  return {
    enabled: Boolean(enabled),
    ready: false,
    checkedAt: null,
    generatedAt: new Date(now()).toISOString(),
    routes: ROUTES.map(({ state, companion }) => ({ state, companion, ready: false, reason: enabled ? "not_checked" : "discord_disabled", botUsername: null })),
  };
}

export async function checkDiscordRouteHealth({
  fetchImpl = fetch,
  enabled = env.discord.enabled,
  botTokens = env.discord.botTokens,
  channelIds = env.discord.channelIds,
  now = () => Date.now(),
} = {}) {
  const checkedAtMs = now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  if (!enabled) return emptyDiscordRouteHealth({ enabled, now: () => checkedAtMs });

  const routes = [];
  for (const { state, companion } of ROUTES) {
    const token = botTokens?.[state] || "";
    const channelId = channelIds?.[state] || "";
    if (!token) {
      routes.push({ state, companion, ready: false, reason: "missing_dedicated_bot_token", botUsername: null });
      continue;
    }
    if (!channelId) {
      routes.push({ state, companion, ready: false, reason: "missing_lifecycle_channel_id", botUsername: null });
      continue;
    }

    try {
      const identity = await botIdentity(fetchImpl, token);
      if (!identity.ok) {
        routes.push({ state, companion, ready: false, reason: identity.reason, botUsername: null });
        continue;
      }
      const identityMatches = normalizedIdentity(identity.username).includes(normalizedIdentity(companion));
      if (!identityMatches) {
        routes.push({ state, companion, ready: false, reason: "bot_identity_mismatch", botUsername: identity.username });
        continue;
      }

      const channel = await proveChannelSendAccess(fetchImpl, token, channelId);
      if (!channel.ok) {
        routes.push({ state, companion, ready: false, reason: channel.reason, botUsername: identity.username });
        continue;
      }
      routes.push({ state, companion, ready: true, reason: null, botUsername: identity.username });
    } catch {
      routes.push({ state, companion, ready: false, reason: "discord_route_check_failed", botUsername: null });
    }
  }

  return {
    enabled: true,
    ready: routes.length === ROUTES.length && routes.every((route) => route.ready),
    checkedAt,
    generatedAt: checkedAt,
    routes,
  };
}
