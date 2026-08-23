import { env } from "../config/env.mjs";
import { buildFateMatchNotificationReadiness } from "../hosted/notification-readiness.mjs";
import { getDiscordRouteHealth } from "./discord-route-health.mjs";

let cachedReadiness = {
  checkedAt: null,
  ready: false,
  discord: getDiscordRouteHealth(),
  hostedFateFind: {
    enabled: Boolean(env.hostedFateFind.enabled),
    configured: Boolean(env.databaseUrl && env.store === "postgres"),
    enabledFinds: null,
    eligibleFinds: null,
    webReadyFinds: null,
    pushReadyFinds: null,
    discordReadyFinds: null,
    hostedMatches24h: null,
    notificationReadiness: null,
  },
};

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeHostedSummary(row = {}, notificationReadiness = null) {
  return {
    enabled: Boolean(env.hostedFateFind.enabled),
    configured: Boolean(env.databaseUrl && env.store === "postgres"),
    enabledFinds: numeric(row.enabled_finds),
    eligibleFinds: numeric(row.eligible_finds),
    webReadyFinds: numeric(row.web_ready_finds),
    pushReadyFinds: numeric(row.push_ready_finds),
    discordReadyFinds: numeric(row.discord_ready_finds),
    hostedMatches24h: numeric(row.hosted_matches_24h),
    notificationReadiness,
  };
}

async function loadHostedSummary(store) {
  if (!env.databaseUrl) return { ...safeHostedSummary(), configured: false, reason: "database_not_configured" };
  if (env.store !== "postgres" || !store || typeof store.pool !== "function") {
    return { ...safeHostedSummary(), configured: false, reason: "postgres_store_required" };
  }

  const pool = await store.pool();
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await pool.query(`
    SELECT
      count(*) FILTER (WHERE f.enabled=true)::int AS enabled_finds,
      count(*) FILTER (
        WHERE f.enabled=true
          AND m.tier IN ('plus','pro')
          AND m.status IN ('active','trialing')
      )::int AS eligible_finds,
      count(*) FILTER (
        WHERE f.enabled=true
          AND m.tier IN ('plus','pro')
          AND m.status IN ('active','trialing')
          AND COALESCE(p.fate_match_enabled,true) <> false
          AND COALESCE(p.web_enabled,true) <> false
          AND COALESCE((f.notification_preferences_json->>'website')::boolean,true) <> false
      )::int AS web_ready_finds,
      count(*) FILTER (
        WHERE f.enabled=true
          AND m.tier IN ('plus','pro')
          AND m.status IN ('active','trialing')
          AND COALESCE(p.fate_match_enabled,true) <> false
          AND COALESCE(p.push_enabled,true) <> false
          AND COALESCE((f.notification_preferences_json->>'app')::boolean,false) = true
          AND EXISTS (
            SELECT 1 FROM fatedrop_push_endpoints pe
            WHERE pe.user_id=f.user_id AND pe.enabled=true
          )
      )::int AS push_ready_finds,
      count(*) FILTER (
        WHERE f.enabled=true
          AND m.tier IN ('plus','pro')
          AND m.status IN ('active','trialing')
          AND COALESCE(p.fate_match_enabled,true) <> false
          AND p.discord_enabled=true
          AND COALESCE((f.notification_preferences_json->>'discord')::boolean,false) = true
          AND EXISTS (
            SELECT 1 FROM fatedrop_discord_links dl
            WHERE dl.user_id=f.user_id
          )
      )::int AS discord_ready_finds,
      (SELECT count(*)::int FROM fatedrop_hosted_fate_matches WHERE matched_at >= $1) AS hosted_matches_24h
    FROM fatedrop_fate_matches f
    LEFT JOIN fatedrop_memberships m ON m.user_id=f.user_id
    LEFT JOIN fatedrop_notification_preferences p ON p.user_id=f.user_id
  `, [now - 86_400]);
  const notificationReadiness = await buildFateMatchNotificationReadiness(pool, { now, since: now - 86_400 });
  return safeHostedSummary(rows?.[0] || {}, notificationReadiness);
}

export async function refreshBetaRuntimeReadiness({ store } = {}) {
  const checkedAt = new Date().toISOString();
  let hostedFateFind;
  try {
    hostedFateFind = await loadHostedSummary(store);
  } catch {
    hostedFateFind = {
      ...safeHostedSummary(),
      configured: Boolean(env.databaseUrl && env.store === "postgres"),
      reason: "readiness_query_failed",
    };
  }

  const discord = getDiscordRouteHealth();
  const webBaselineReady = hostedFateFind.eligibleFinds === 0 || hostedFateFind.webReadyFinds === hostedFateFind.eligibleFinds;
  const notificationQueueReady = hostedFateFind.notificationReadiness?.ready !== false;
  cachedReadiness = {
    checkedAt,
    ready: Boolean(discord?.ready) && hostedFateFind.configured && webBaselineReady && notificationQueueReady,
    discord,
    hostedFateFind,
  };
  return cachedReadiness;
}

export function getBetaRuntimeReadiness() {
  return cachedReadiness;
}

export async function recordBetaRuntimeReadiness({ store } = {}) {
  const readiness = await refreshBetaRuntimeReadiness({ store });
  if (!store || typeof store.recordNetworkSnapshot !== "function") return { recorded: false, readiness };

  const measuredAt = Math.floor(Date.now() / 1000);
  const [stats, retailers] = await Promise.all([
    typeof store.stats === "function" ? store.stats() : {},
    typeof store.listRetailers === "function" ? store.listRetailers() : [],
  ]);
  await store.recordNetworkSnapshot({
    id: `beta-runtime:${measuredAt}`,
    measuredAt,
    metrics: {
      ...stats,
      betaRuntimeReadiness: readiness,
    },
    retailers,
  });
  return { recorded: true, readiness };
}
