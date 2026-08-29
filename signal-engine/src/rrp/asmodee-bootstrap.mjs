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
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count, max(rrp_observed_at)::bigint AS latest_observed_at FROM fatedrop_products WHERE rrp_source='asmodee-uk' AND official_rrp_pence IS NOT NULL",
  );
  const existing = Number(rows[0]?.count || 0);
  const latestObservedAt = Number(rows[0]?.latest_observed_at || 0) || null;
  const safeMaxAge = Number.isFinite(maxAgeSeconds) && maxAgeSeconds >= 0
    ? Math.floor(maxAgeSeconds)
    : DEFAULT_MAX_AGE_SECONDS;
  const ageSeconds = latestObservedAt == null ? null : Math.max(0, now - latestObservedAt);

  if (existing > 0 && latestObservedAt != null && ageSeconds < safeMaxAge) {
    return {
      skipped: true,
      reason: "authoritative_evidence_fresh",
      existing,
      latestObservedAt,
      ageSeconds,
    };
  }

  const result = await syncFn({ databaseUrl, pool, now });
  return {
    skipped: false,
    refreshReason: existing === 0 ? "not_bootstrapped" : "authoritative_evidence_stale",
    previous: { existing, latestObservedAt, ageSeconds },
    result,
  };
}
