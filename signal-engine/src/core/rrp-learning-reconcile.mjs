import { buildRrpValueContext, resolveRrpValue } from "./rrp-value-reference.mjs";
import { rrpAliasSignature, rrpLearningId } from "./rrp-learning.mjs";
import { recordVerifiedRrpAlias } from "../stores/rrp-learning-store.mjs";

const DEFAULT_LIMIT = 100;

function unique(values = []) { return [...new Set(values.filter(Boolean))]; }
function conflictReason(reason = "") { return /conflict/i.test(String(reason)); }

export async function reconcileRrpLearningQueue({ store, limit = DEFAULT_LIMIT, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!store?.pool || typeof store.listProducts !== "function") {
    return { enabled: false, checked: 0, resolved: 0, conflicts: 0, remaining: null };
  }
  const pool = await store.pool();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const [{ rows }, products] = await Promise.all([
    pool.query(`
      SELECT *
      FROM fatedrop_rrp_resolution_queue
      WHERE status IN ('open','candidate')
      ORDER BY occurrence_count DESC, last_seen_at DESC
      LIMIT $1
    `, [safeLimit]),
    store.listProducts({ limit: 5000 }),
  ]);
  const context = buildRrpValueContext(products);
  let resolved = 0;
  let conflicts = 0;

  for (const row of rows) {
    const result = resolveRrpValue({
      title: row.observed_title,
      productType: row.product_type || undefined,
      tcg: row.tcg || "pokemon",
      language: row.language_code || undefined,
      region: row.region_code || undefined,
      linkedProduct: {
        title: row.observed_title,
        productType: row.product_type || undefined,
        tcg: row.tcg || "pokemon",
        officialRrpPence: null,
      },
    }, context);
    const matchedProductIds = unique(result?.matchedProductIds || []);

    if (result?.resolved && result.kind === "official" && matchedProductIds.length === 1) {
      const aliasSignature = rrpAliasSignature({ tcg: row.tcg || "pokemon", title: row.observed_title, productType: row.product_type || null });
      await recordVerifiedRrpAlias(pool, {
        id: rrpLearningId("rrpa", aliasSignature),
        tcg: row.tcg || "pokemon",
        aliasSignature,
        observedTitle: row.observed_title,
        productType: row.product_type || null,
        canonicalProductIdentityId: matchedProductIds[0],
        resolutionKind: "verified_wording",
        confidence: 1,
        source: result.rrpSource || "rrp-learning-reconciler",
        verifiedAt: now,
        retailerId: row.retailer_id,
        evidence: {
          resolution_source: "rrp-learning-reconciler",
          reference_basis: result.referenceBasis || null,
          rrp_pence: result.rrpPence,
          queue_id: row.id,
        },
      });
      resolved += 1;
      continue;
    }

    if (conflictReason(result?.reason)) {
      await pool.query(`
        UPDATE fatedrop_rrp_resolution_queue
        SET status='conflict', resolution_source=$1,
            evidence_json=evidence_json || $2::jsonb
        WHERE id=$3
      `, [String(result.reason), JSON.stringify({ reconciled_at: now }), row.id]);
      conflicts += 1;
    }
  }

  const { rows: countRows } = await pool.query(`SELECT count(*)::int AS remaining FROM fatedrop_rrp_resolution_queue WHERE status IN ('open','candidate')`);
  return {
    enabled: true,
    checked: rows.length,
    resolved,
    conflicts,
    remaining: Number(countRows[0]?.remaining || 0),
  };
}
