import { env } from "../config/env.mjs";
import { buildFateMatchNotificationReadiness } from "../hosted/notification-readiness.mjs";
import { getDiscordRouteHealth } from "./discord-route-health.mjs";
import { loadEffectiveRrpCoverage } from "./effective-rrp-coverage.mjs";
import { getWebsiteSnapshotHealth } from "./website-snapshot-health.mjs";

function defaults() {
  return {
    databaseConfigured: Boolean(env.databaseUrl),
    store: env.store,
    hostedFateFindEnabled: Boolean(env.hostedFateFind.enabled),
    hostedFateFindExplicitlyConfigured: Boolean(env.hostedFateFind.explicitlyConfigured),
  };
}

let cachedReadiness = {
  checkedAt: null,
  ready: false,
  infrastructureReady: false,
  signalNetworkReady: false,
  signalNetwork: {
    ready: false,
    configuredRetailers: 0,
    baselineRetailers: 0,
    freshRetailers: 0,
    minimumFreshRetailers: 1,
    staleOrUnhealthyRetailers: 0,
    latestSuccessAt: null,
    reason: "not_checked",
  },
  websiteSnapshot: getWebsiteSnapshotHealth(),
  discord: getDiscordRouteHealth(),
  hostedFateFind: {
    enabled: Boolean(env.hostedFateFind.enabled),
    explicitlyConfigured: Boolean(env.hostedFateFind.explicitlyConfigured),
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

function safeHostedSummary(row = {}, notificationReadiness = null, runtime = defaults()) {
  return {
    enabled: Boolean(runtime.hostedFateFindEnabled),
    explicitlyConfigured: Boolean(runtime.hostedFateFindExplicitlyConfigured),
    configured: Boolean(runtime.databaseConfigured && runtime.store === "postgres"),
    enabledFinds: numeric(row.enabled_finds),
    eligibleFinds: numeric(row.eligible_finds),
    webReadyFinds: numeric(row.web_ready_finds),
    pushReadyFinds: numeric(row.push_ready_finds),
    discordReadyFinds: numeric(row.discord_ready_finds),
    hostedMatches24h: numeric(row.hosted_matches_24h),
    notificationReadiness,
  };
}

export function summarizeSignalNetworkReadiness(retailers = [], { minimumFreshRetailers = 3 } = {}) {
  const rows = Array.isArray(retailers) ? retailers : [];
  const baseline = rows.filter((retailer) => retailer?.baselineCompleted !== false);
  const fresh = baseline.filter((retailer) => retailer?.healthy === true && retailer?.stale !== true);
  const required = Math.min(
    Math.max(1, Math.round(Number(minimumFreshRetailers) || 3)),
    Math.max(1, baseline.length),
  );
  const latestSuccessAt = rows.reduce((latest, retailer) => Math.max(latest, Number(retailer?.lastSuccessAt) || 0), 0) || null;
  const ready = baseline.length > 0 && fresh.length >= required;
  return {
    ready,
    configuredRetailers: rows.length,
    baselineRetailers: baseline.length,
    freshRetailers: fresh.length,
    minimumFreshRetailers: required,
    staleOrUnhealthyRetailers: Math.max(0, rows.length - fresh.length),
    latestSuccessAt,
    reason: ready ? null : baseline.length === 0 ? "no_completed_retailer_baseline" : "insufficient_fresh_retailers",
  };
}

export function summarizeBetaRuntimeReadiness({ discord, hostedFateFind, signalNetwork, websiteSnapshot, checkedAt = new Date().toISOString() } = {}) {
  const eligibleFinds = numeric(hostedFateFind?.eligibleFinds);
  const webBaselineReady = eligibleFinds === 0 || numeric(hostedFateFind?.webReadyFinds) === eligibleFinds;
  const notificationQueueReady = hostedFateFind?.notificationReadiness?.ready !== false;
  const infrastructureReady = Boolean(discord?.ready)
    && Boolean(hostedFateFind?.configured)
    && webBaselineReady
    && notificationQueueReady
    && websiteSnapshot?.ready === true;
  const hostedActivationReady = eligibleFinds === 0 || hostedFateFind?.enabled === true;
  const signalNetworkReady = signalNetwork?.ready === true;
  return {
    checkedAt,
    ready: infrastructureReady && hostedActivationReady && signalNetworkReady,
    infrastructureReady,
    signalNetworkReady,
    signalNetwork,
    websiteSnapshot,
    discord,
    hostedFateFind,
  };
}

async function loadHostedSummary(store, { runtime = defaults(), now = Math.floor(Date.now() / 1000) } = {}) {
  if (!runtime.databaseConfigured) return { ...safeHostedSummary({}, null, runtime), configured: false, reason: "database_not_configured" };
  if (runtime.store !== "postgres" || !store || typeof store.pool !== "function") {
    return { ...safeHostedSummary({}, null, runtime), configured: false, reason: "postgres_store_required" };
  }

  const pool = await store.pool();
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
  return safeHostedSummary(rows?.[0] || {}, notificationReadiness, runtime);
}

async function loadSignalNetworkSummary(store) {
  if (!store || typeof store.listRetailers !== "function") {
    return summarizeSignalNetworkReadiness([]);
  }
  const retailers = await store.listRetailers();
  return summarizeSignalNetworkReadiness(retailers);
}

export async function refreshBetaRuntimeReadiness({ store, runtime = defaults(), discord = getDiscordRouteHealth(), websiteSnapshot = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const checkedAt = new Date(now * 1000).toISOString();
  let hostedFateFind;
  try {
    hostedFateFind = await loadHostedSummary(store, { runtime, now });
  } catch {
    hostedFateFind = {
      ...safeHostedSummary({}, null, runtime),
      configured: Boolean(runtime.databaseConfigured && runtime.store === "postgres"),
      reason: "readiness_query_failed",
    };
  }

  let signalNetwork;
  try {
    signalNetwork = await loadSignalNetworkSummary(store);
  } catch {
    signalNetwork = {
      ...summarizeSignalNetworkReadiness([]),
      reason: "retailer_health_query_failed",
    };
  }

  const snapshotHealth = websiteSnapshot ?? getWebsiteSnapshotHealth({ now });
  cachedReadiness = summarizeBetaRuntimeReadiness({ discord, hostedFateFind, signalNetwork, websiteSnapshot: snapshotHealth, checkedAt });
  return cachedReadiness;
}

export function getBetaRuntimeReadiness() { return cachedReadiness; }

export async function recordBetaRuntimeReadiness({ store, runtime, discord, websiteSnapshot = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const readiness = await refreshBetaRuntimeReadiness({ store, runtime, discord, websiteSnapshot, now });
  if (!store || typeof store.recordNetworkSnapshot !== "function") return { recorded: false, readiness };

  const [stats, retailers, effectiveRrpCoverage] = await Promise.all([
    typeof store.stats === "function" ? store.stats() : {},
    typeof store.listRetailers === "function" ? store.listRetailers() : [],
    loadEffectiveRrpCoverage(store),
  ]);
  await store.recordNetworkSnapshot({
    id: `beta-runtime:${now}`,
    measuredAt: now,
    metrics: { ...stats, betaRuntimeReadiness: readiness, effectiveRrpCoverage },
    retailers,
  });
  return { recorded: true, readiness, effectiveRrpCoverage };
}