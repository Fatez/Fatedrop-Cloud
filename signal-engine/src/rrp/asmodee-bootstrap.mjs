import { syncAsmodeeRrp } from "./asmodee-authority.mjs";

export async function bootstrapAsmodeeRrp({ store, databaseUrl, syncFn = syncAsmodeeRrp } = {}) {
  if (!databaseUrl) return { skipped: true, reason: "database_not_configured" };
  if (!store || typeof store.pool !== "function") return { skipped: true, reason: "persistent_store_not_available" };

  const pool = await store.pool();
  const { rows } = await pool.query(
    "SELECT count(*)::int AS count FROM fatedrop_products WHERE rrp_source='asmodee-uk' AND official_rrp_pence IS NOT NULL",
  );
  const existing = Number(rows[0]?.count || 0);
  if (existing > 0) return { skipped: true, reason: "already_bootstrapped", existing };

  const result = await syncFn({ databaseUrl });
  return { skipped: false, result };
}
