import { syncAsmodeeRrpWithPool } from "./asmodee-store-sync.mjs";

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

export async function bootstrapAsmodeeRrp({
  store,
  databaseUrl,
  syncFn = syncAsmodeeRrpWithPool,
  now = Math.floor(Date.now() / 1000),
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
} = {}) {
  if (!databaseUrl) return { skipped: true, reason: "database_not_configured" };
  if (!store || typeof store.pool !== "function") return { skipped: true, reason: "persistent_store_not_available" };

  const pool = await store.pool();
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE rrp_source='asmodee-uk' AND official_rrp_pence IS NOT NULL
      )::int AS count,
      MAX(rrp_observed_at) FILTER (
        WHERE rrp_source='asmodee-uk' AND official_rrp_pence IS NOT NULL
      )::bigint AS latest_observed_at,
      MAX(first_seen_at) FILTER (
        WHERE LOWER(COALESCE(tcg,'pokemon'))='pokemon'
          AND (official_rrp_pence IS NULL OR rrp_source IS NULL)
      )::bigint AS latest_unresolved_first_seen_at
    FROM fatedrop_products
  `);
  const existing = Number(rows[0]?.count || 0);
  const latestObservedAt = Number(rows[0]?.latest_observed_at || 0) || null;
  const latestUnresolvedFirstSeenAt = Number(rows[0]?.latest_unresolved_first_seen_at || 0) || null;
  const safeMaxAge = Number.isFinite(maxAgeSeconds) && maxAgeSeconds >= 0
    ? Math.floor(maxAgeSeconds)
    : DEFAULT_MAX_AGE_SECONDS;
  const ageSeconds = latestObservedAt == null ? null : Math.max(0, now - latestObservedAt);
  const catalogueAdvancedAfterAuthority = latestObservedAt != null
    && latestUnresolvedFirstSeenAt != null
    && latestUnresolvedFirstSeenAt > latestObservedAt;

  if (existing > 0 && latestObservedAt != null && ageSeconds < safeMaxAge && !catalogueAdvancedAfterAuthority) {
    return {
      skipped: true,
      reason: "authoritative_evidence_fresh",
      existing,
      latestObservedAt,
      latestUnresolvedFirstSeenAt,
      ageSeconds,
    };
  }

  const result = await syncFn({ databaseUrl, pool, now });
  return {
    skipped: false,
    refreshReason: existing === 0
      ? "not_bootstrapped"
      : catalogueAdvancedAfterAuthority
        ? "catalogue_advanced_after_authority"
        : "authoritative_evidence_stale",
    previous: {
      existing,
      latestObservedAt,
      latestUnresolvedFirstSeenAt,
      ageSeconds,
    },
    result,
  };
}