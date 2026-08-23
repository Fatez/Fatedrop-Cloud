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

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function routeBase(state, companion) {
  return { state, companion, configured: false, ready: false, reason: null, botUsername: null, channelName: null };
}

export function emptyDiscordRouteHealth({ enabled = env.discord.enabled, now = () => Date.now() } = {}) {
  const generatedAt = new Date(now()).toISOString();
  return {
    enabled: Boolean(enabled),
    ready: false,
    checkedAt: null,
    generatedAt,
    routes: ROUTES.map(({ state, companion }) => ({
      ...routeBase(state, companion),
      reason: enabled ? "not_checked" : "discord_disabled",
    })),
  };
}

let cachedHealth = emptyDiscordRouteHealth();

async function botIdentity(fetchImpl, token) {
  const response = await fetchImpl(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!response?.ok) return { ok: false, reason: safeReason("discord_identity_http", response) };
  const payload = await safeJson(response);
  const username = String(payload?.username || payload?.global_name || "").trim();
  if (!username) return { ok: false, reason: "discord_identity_missing_username" };
  return { ok: true, username };
}

async function channelIdentity(fetchImpl, token, channelId) {
  const response = await fetchImpl(`${DISCORD_API}/channels/${channelId}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!response?.ok) return { ok: false, reason: safeReason("discord_channel_lookup_http", response) };
  const payload = await safeJson(response);
  return { ok: true, name: String(payload?.name || "").trim() || null };
}

async function proveChannelSendAccess(fetchImpl, token, channelId) {
  const response = await fetchImpl(`${DISCORD_API}/channels/${channelId}/typing`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
  });
  if (response?.ok || response?.status === 204) return { ok: true };
  return { ok: false, reason: safeReason("discord_channel_send_http", response) };
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
    const base = routeBase(state, companion);
    const token = botTokens?.[state] || "";
    const channelId = channelIds?.[state] || "";
    if (!token) {
      routes.push({ ...base, reason: "missing_dedicated_bot_token" });
      continue;
    }
    if (!channelId) {
      routes.push({ ...base, reason: "missing_lifecycle_channel_id" });
      continue;
    }

    try {
      const identity = await botIdentity(fetchImpl, token);
      if (!identity.ok) {
        routes.push({ ...base, configured: true, reason: identity.reason });
        continue;
      }
      if (!normalizedIdentity(identity.username).includes(normalizedIdentity(companion))) {
        routes.push({ ...base, configured: true, reason: "bot_identity_mismatch", botUsername: identity.username });
        continue;
      }

      const channel = await channelIdentity(fetchImpl, token, channelId);
      if (!channel.ok) {
        routes.push({ ...base, configured: true, reason: channel.reason, botUsername: identity.username });
        continue;
      }

      const sendAccess = await proveChannelSendAccess(fetchImpl, token, channelId);
      if (!sendAccess.ok) {
        routes.push({
          ...base,
          configured: true,
          reason: sendAccess.reason,
          botUsername: identity.username,
          channelName: channel.name,
        });
        continue;
      }

      routes.push({
        ...base,
        configured: true,
        ready: true,
        botUsername: identity.username,
        channelName: channel.name,
      });
    } catch {
      routes.push({ ...base, configured: true, reason: "discord_route_check_failed" });
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

export async function refreshDiscordRouteHealth(options = {}) {
  cachedHealth = await checkDiscordRouteHealth(options);
  return cachedHealth;
}

export function getDiscordRouteHealth() {
  return cachedHealth;
}

export async function persistDiscordRouteHealth(store, health = cachedHealth) {
  if (!store || typeof store.pool !== "function") return { persisted: false, reason: "persistent_store_unavailable" };
  const pool = await store.pool();
  const { rows } = await pool.query(`
    UPDATE fatedrop_signal_network_snapshots
    SET metrics = jsonb_set(COALESCE(metrics, '{}'::jsonb), '{discordRouteHealth}', $1::jsonb, true)
    WHERE id = (
      SELECT id FROM fatedrop_signal_network_snapshots
      ORDER BY measured_at DESC LIMIT 1
    )
    RETURNING id, measured_at
  `, [JSON.stringify(health)]);
  if (!rows[0]) return { persisted: false, reason: "network_snapshot_unavailable" };
  return { persisted: true, measuredAt: Number(rows[0].measured_at || 0) || null };
}

export const DISCORD_ROUTE_HEALTH_STATES = Object.freeze(ROUTES.map((route) => route.state));
