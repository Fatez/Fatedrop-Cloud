import { buildRrpGapSnapshot } from "../core/rrp-gap-intelligence.mjs";

const DEFAULT_QUERY_LIMIT = 2500;

export async function loadRrpGapIntelligence(store, {
  now = Math.floor(Date.now() / 1000),
  topLimit = 20,
  queryLimit = DEFAULT_QUERY_LIMIT,
} = {}) {
  if (!store || typeof store.pool !== "function") {
    return { available: false, reason: "persistent_store_unavailable", generatedAt: now };
  }

  const pool = await store.pool();
  const safeQueryLimit = Math.max(100, Math.min(10_000, Number(queryLimit) || DEFAULT_QUERY_LIMIT));
  const safeTopLimit = Math.max(1, Math.min(50, Number(topLimit) || 20));

  try {
    const [open, statuses] = await Promise.all([
      pool.query(`
        SELECT *
        FROM fatedrop_rrp_resolution_queue
        WHERE status IN ('open','candidate')
        ORDER BY last_seen_at DESC, occurrence_count DESC
        LIMIT $1
      `, [safeQueryLimit]),
      pool.query(`
        SELECT status, count(*)::int AS rows,
               COALESCE(sum(occurrence_count),0)::bigint AS observations,
               max(last_seen_at)::bigint AS latest_seen_at
        FROM fatedrop_rrp_resolution_queue
        GROUP BY status
        ORDER BY status
      `),
    ]);

    const snapshot = buildRrpGapSnapshot(open.rows || [], { now, limit: safeTopLimit });
    return {
      available: true,
      evidenceScope: "rrp_resolution_queue",
      ...snapshot,
      queryLimit: safeQueryLimit,
      queueStatus: Object.fromEntries((statuses.rows || []).map((row) => [String(row.status), {
        rows: Number(row.rows || 0),
        observations: Number(row.observations || 0),
        latestSeenAt: row.latest_seen_at == null ? null : Number(row.latest_seen_at),
      }])),
    };
  } catch (error) {
    return {
      available: false,
      reason: "rrp_gap_query_failed",
      generatedAt: now,
      detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined,
    };
  }
}
