import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export async function consumeFateFindEvaluationCapability(store, {
  fateFindId,
  token,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const cleanId = String(fateFindId || "").trim();
  const cleanToken = String(token || "").trim();
  if (!cleanId || !cleanToken || typeof store?.pool !== "function") return false;

  const pool = await store.pool();
  try {
    const { rows } = await pool.query(`
      DELETE FROM fatedrop_fatefind_evaluation_capabilities
      WHERE token_hash = $1
        AND fate_find_id = $2
        AND expires_at >= $3
      RETURNING token_hash
    `, [sha256(cleanToken), cleanId, now]);
    return rows.length === 1;
  } catch (error) {
    if (error?.code === "42P01") return false;
    throw error;
  }
}
