import { createHash } from "node:crypto";
import { buildRrpValueContext, resolveRrpValue } from "./rrp-value-reference.mjs";
import { rrpAliasSignature, rrpLearningId } from "./rrp-learning.mjs";
import { recordVerifiedRrpAlias } from "../stores/rrp-learning-store.mjs";

const DEFAULT_LIMIT = 250;
const ESCALATION_OCCURRENCES = 10;
const AUTHORITY_GRAPH_LIMIT = 20000;
const RECONCILER_RULES_VERSION = "rrp-self-heal-v3";

function unique(values = []) { return [...new Set(values.filter(Boolean))]; }
function conflictReason(reason = "") { return /conflict/i.test(String(reason)); }

function authorityFingerprint(products = []) {
  const facts = (products || [])
    .filter((product) => Number.isFinite(product?.officialRrpPence) && product.officialRrpPence > 0 && product?.rrpSource)
    .map((product) => [
      product.id || "",
      product.title || "",
      product.productType || "",
      Math.round(product.officialRrpPence),
      product.rrpSource || "",
      Number(product.rrpObservedAt || product.updatedAt || 0),
    ].join("|"))
    .sort()
    .join("\n");
  return `${RECONCILER_RULES_VERSION}:${createHash("sha256").update(facts).digest("hex").slice(0, 16)}`;
}

function reconciliationDisposition(reason = "") {
  const value = String(reason || "verified_rrp_unavailable");
  if (conflictReason(value)) {
    return {
      classification: "authority_conflict",
      nextAction: "hold_fail_closed_until_authority_conflict_is_resolved",
    };
  }
  if (value === "no_authoritative_candidate" || value === "registry_unavailable") {
    return {
      classification: "authority_gap",
      nextAction: "await_or_refresh_authoritative_rrp_source",
    };
  }
  if (value === "no_exact_identity_match" || value === "identity_bucket_unavailable" || value === "reference_identity_too_weak") {
    return {
      classification: "identity_gap",
      nextAction: "review_verified_identity_or_safe_alias_evidence",
    };
  }
  if (value === "no_verified_pack_reference") {
    return {
      classification: "component_authority_gap",
      nextAction: "await_verified_equivalent_pack_reference",
    };
  }
  return {
    classification: "unresolved_reference",
    nextAction: "retry_after_authority_or_identity_evidence_changes",
  };
}

function canDeferEscalatedRow(row, fingerprint) {
  const evidence = row?.evidence_json && typeof row.evidence_json === "object" ? row.evidence_json : {};
  return evidence.escalated === true
    && evidence.authority_fingerprint === fingerprint
    && evidence.reconciler_rules_version === RECONCILER_RULES_VERSION;
}

async function recordUnresolvedDisposition(pool, row, result, now, fingerprint) {
  const reason = String(result?.reason || row.failure_reason || "verified_rrp_unavailable");
  const disposition = reconciliationDisposition(reason);
  const occurrenceCount = Number(row.occurrence_count || 0);
  const escalated = occurrenceCount >= ESCALATION_OCCURRENCES;
  await pool.query(`
    UPDATE fatedrop_rrp_resolution_queue
    SET failure_reason=$1,
        evidence_json=evidence_json || $2::jsonb
    WHERE id=$3
  `, [reason, JSON.stringify({
    reconciled_at: now,
    reconciliation_class: disposition.classification,
    next_action: disposition.nextAction,
    escalated,
    escalation_threshold: ESCALATION_OCCURRENCES,
    authority_fingerprint: fingerprint,
    reconciler_rules_version: RECONCILER_RULES_VERSION,
  }), row.id]);
  return { ...disposition, escalated };
}

export async function reconcileRrpLearningQueue({ store, limit = DEFAULT_LIMIT, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!store?.pool || typeof store.listProducts !== "function") {
    return { enabled: false, checked: 0, resolved: 0, conflicts: 0, escalated: 0, deferred: 0, remaining: null };
  }
  const pool = await store.pool();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  // RRP authority is global catalogue truth. Do not truncate the resolver context to
  // the historical 5k product window; otherwise valid authority can exist in Neon
  // but remain invisible to self-healing.
  const products = await store.listProducts({ limit: AUTHORITY_GRAPH_LIMIT });
  const context = buildRrpValueContext(products);
  const fingerprint = authorityFingerprint(products);

  // Exclude already-escalated rows at the database selection boundary when neither
  // the authoritative RRP graph nor resolver rules have changed. Filtering only in
  // the JS loop would let those rows occupy the LIMIT forever and starve the rest
  // of the queue. COALESCE is intentional: legacy rows have no self-heal metadata.
  const { rows } = await pool.query(`
    SELECT *
    FROM fatedrop_rrp_resolution_queue
    WHERE status IN ('open','candidate')
      AND NOT (
        COALESCE(evidence_json->>'escalated','false')='true'
        AND COALESCE(evidence_json->>'authority_fingerprint','')=$2
        AND COALESCE(evidence_json->>'reconciler_rules_version','')=$3
      )
    ORDER BY occurrence_count DESC, last_seen_at DESC
    LIMIT $1
  `, [safeLimit, fingerprint, RECONCILER_RULES_VERSION]);

  let resolved = 0;
  let conflicts = 0;
  let escalated = 0;
  let deferred = 0;

  for (const row of rows) {
    // Keep a second defensive gate in case a non-Postgres test/store path supplies
    // a row that the SQL boundary would normally have filtered.
    if (canDeferEscalatedRow(row, fingerprint)) {
      deferred += 1;
      continue;
    }

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

    // Only exact official identity matches are persisted as official RRP. Pack and
    // component references remain useful at render/evaluation time but are never
    // promoted into product-level official RRP truth by self-healing.
    if (result?.resolved && result.kind === "official" && matchedProductIds.length === 1) {
      const aliasSignature = rrpAliasSignature({ tcg: row.tcg || "pokemon", title: row.observed_title, productType: row.product_type || null });
      await recordVerifiedRrpAlias(pool, {
        id: rrpLearningId("rrpa", aliasSignature),
        tcg: row.tcg || "pokemon",
        aliasSignature,
        observedTitle: row.observed_title,
        observedProductId: row.product_id || null,
        productType: row.product_type || null,
        canonicalProductIdentityId: matchedProductIds[0],
        resolutionKind: "verified_wording",
        confidence: 1,
        source: result.rrpSource || "rrp-learning-reconciler",
        officialRrpPence: result.rrpPence,
        rrpSource: result.rrpSource || "rrp-learning-reconciler",
        rrpObservedAt: result.rrpObservedAt || now,
        verifiedAt: now,
        retailerId: row.retailer_id,
        evidence: {
          resolution_source: "rrp-learning-reconciler",
          reference_basis: result.referenceBasis || null,
          rrp_pence: result.rrpPence,
          queue_id: row.id,
          observed_product_id: row.product_id || null,
          authority_fingerprint: fingerprint,
          reconciler_rules_version: RECONCILER_RULES_VERSION,
        },
      });
      resolved += 1;
      continue;
    }

    const disposition = await recordUnresolvedDisposition(pool, row, result, now, fingerprint);
    if (disposition.escalated) escalated += 1;

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
    escalated,
    deferred,
    authorityProducts: context.registry?.authoritativeProducts || 0,
    authorityGraphProducts: products.length,
    remaining: Number(countRows[0]?.remaining || 0),
  };
}
