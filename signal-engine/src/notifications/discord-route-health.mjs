import { env } from "../config/env.mjs";
import { companionForSignal, discordChannelForState } from "./discord.mjs";

const DISCORD_API = "https://discord.com/api/v10";
const STATES = Object.freeze(["whisper", "echo", "manifested", "vanished"]);

let cachedHealth = {
  checkedAt: null,
  healthy: false,
  routes: Object.fromEntries(STATES.map((state) => [state, {
    state,
    companion: companionForSignal(state),
    configured: false,
    healthy: false,
    reason: "not_checked",
  }])),
};

async function safeJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function normalizedIdentity(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function failure(state, reason, extra = {}) {
  return {
    state,
    companion: companionForSignal(state),
    configured: !["missing_dedicated_bot_token", "missing_lifecycle_channel_id"].includes(reason),
    healthy: false,
    reason,
    ...extra,
  };
}

export async function probeDiscordRoute(state, {
  fetchImpl = fetch,
  enabled = env.discord.enabled,
  botTokens = env.discord.botTokens,
  channelIds = env.discord.channelIds,
  fallbackChannelId = env.discord.premiumDropsChannelId,
} = {}) {
  if (!STATES.includes(state)) return failure(state, "unsupported_state");

  // Health deliberately requires the dedicated lifecycle identity even though
  // ordinary delivery still retains the generic-token fallback during migration.
  const botToken = botTokens?.[state] || "";
  if (!botToken) return failure(state, "missing_dedicated_bot_token");

  const channelId = discordChannelForState(state, { channelIds, fallbackChannelId });
  if (!channelId) return failure(state, "missing_lifecycle_channel_id");
  if (!enabled) return failure(state, "disabled", { configured: true });

  const checkedAt = new Date().toISOString();
  const headers = { Authorization: `Bot ${botToken}` };

  try {
    const meResponse = await fetchImpl(`${DISCORD_API}/users/@me`, { headers });
    if (!meResponse.ok) return failure(state, "bot_auth_failed", { configured: true, checkedAt, httpStatus: meResponse.status });
    const bot = await safeJson(meResponse);
    const botUsername = String(bot.username || bot.global_name || "").trim() || null;
    const expected = normalizedIdentity(companionForSignal(state));
    const actual = normalizedIdentity(botUsername || "");
    if (!actual || !actual.includes(expected)) {
      return failure(state, "bot_identity_mismatch", { configured: true, checkedAt, botUsername });
    }

    const channelResponse = await fetchImpl(`${DISCORD_API}/channels/${channelId}`, { headers });
    if (!channelResponse.ok) return failure(state, "channel_unreachable", { configured: true, checkedAt, httpStatus: channelResponse.status, botUsername });
    const channel = await safeJson(channelResponse);

    // Discord's typing endpoint proves the bot can interact with the target
    // channel but leaves no persistent message and creates no FateDrop signal.
    const typingResponse = await fetchImpl(`${DISCORD_API}/channels/${channelId}/typing`, {
      method: "POST",
      headers,
    });
    if (!typingResponse.ok) {
      return failure(state, "send_permission_failed", {
        configured: true,
        checkedAt,
        httpStatus: typingResponse.status,
        botUsername,
        channelName: channel.name || null,
      });
    }

    return {
      state,
      companion: companionForSignal(state),
      configured: true,
      healthy: true,
      reason: null,
      checkedAt,
      botUsername,
      channelName: channel.name || null,
    };
  } catch {
    return failure(state, "probe_failed", { configured: true, checkedAt });
  }
}

export async function refreshDiscordRouteHealth(options = {}) {
  const routes = {};
  for (const state of STATES) routes[state] = await probeDiscordRoute(state, options);
  cachedHealth = {
    checkedAt: new Date().toISOString(),
    healthy: STATES.every((state) => routes[state]?.healthy === true),
    routes,
  };
  return cachedHealth;
}

export function getDiscordRouteHealth() { return cachedHealth; }
export { STATES as DISCORD_ROUTE_HEALTH_STATES };
