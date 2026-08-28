import { createHash } from "node:crypto";
import { buildRrpValueContext, resolveRrpValue } from "./rrp-value-reference.mjs";
import {
  buildRrpGapSnapshot,
  currentRrpObservationFingerprint,
  rankRrpGapRows,
} from "./rrp-gap-intelligence.mjs";
import { rrpAliasSignature, rrpLearningId } from "./rrp-learning.mjs";
import { recordVerifiedRrpAlias } from "../stores/rrp-learning-store.mjs";

const DEFAULT_LIMIT = 250;
const ESCALATION_OCCURRENCES = 10;
const AUTHORITY_GRAPH_LIMIT = 20000;
const RECONCILER_RULES_VERSION = "rrp-self-heal-v4-knowledge-gap";

function unique(values = []) { return [...new Set(values.filter(Boolean))]; }
function conflictReason(reason = "") { return /conflict/i.test(String(reason)); }

function dbAuthorityProduct(row = {}) {
  return {
    id: row.id,
    title: row.title,
    productType: row.product_type,
    tcg: row.tcg || "pokemon",
    officialRrpPence: row.official_rrp_pence == null ? null : Number(row.official_rrp_pence),
    rrpSource: row.rrp_source || null,
    rrpObservedAt: row.rrp_observed_at == null ? null : Number(row.rrp_observed_at),
    updatedAt: row.updated_at == null ? null : Number(row.updated_at),
  };
}

async function loadAuthorityProducts(pool, store) {
  // The normal catalogue read intentionally has a bounded product window. RRP
  // healing needs a different view: every authoritative RRP row, regardless of
  // catalogue recency, so older verified products cannot fall out of the resolver.
  try {
    const { rows } = await pool.query(`
      SELECT id,title,product_type,tcg,official_rrp_pence,rrp_source,rrp_observed_at,updated_at
      FROM fatedrop_products
      WHERE official_rrp_pence IS NOT NULL AND official_rrp_pence > 0
        AND rrp_source IS NOT NULL AND btrim(rrp_source) <> ''
      ORDER BY updated_at DESC
      LIMIT $1
    `, [AUTHORITY_GRAPH_LIMIT]);
    if (rows?.length) return rows.map(dbAuthorityProduct);
  } catch {
    // File/test stores do not necessarily expose the production SQL schema.
  }
  return store.listProducts({ limit: AUTHORITY_GRAPH_LIMIT });
}

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

function canDeferEscalatedRow(row, fingerprint) {
  const evidence = row?.evidence_json && typeof row.evidence_json === "object" ? row.evidence_json : {};
  const currentObservationFingerprint = currentRrpObservationFingerprint(row);
  return evidence.escalated === true
    && evidence.authority_fingerprint === fingerprint
    && evidence.reconciler_rules_version === RECONCILER_RULES_VERSION
    && evidence.reconciled_observation_fingerprint === currentObservationFingerprint;
}

async function recordUnresolvedDisposition(pool, row, result, now, fingerprint, intelligence = {}) {
  const reason = String(result?.reason || row.failure_reason || "verified_rrp_unavailable");
  const occurrenceCount = Number(row.occurrence_count || 0);
  const escalated = occurrenceCount >= ESCALATION_OCCURRENCES;
  const currentObservationFingerprint = intelligence.currentObservationFingerprint || currentRrpObservationFingerprint(row);
  const classification = intelligence.classification || "unresolved_reference";
  const nextAction = intelligence.nextAction || "retry_after_authority_or_identity_evidence_changes";
  await pool.query(`
    UPDATE fatedrop_rrp_resolution_queue
    SET failure_reason=$1,
        evidence_json=evidence_json || $2::jsonb
    WHERE id=$3
  `, [reason, JSON.stringify({
    reconciled_at: now,
    reconciliation_class: classification,
    next_action: nextAction,
    actionability: intelligence.actionability || "evidence_watch",
    knowledge_priority: Number(intelligence.priority || 0),
    cross_retailer_count: Number(intelligence.crossRetailerCount || 1),
    live_offer: intelligence.liveOffer === true,
    identifier_evidence: intelligence.hasIdentifierEvidence === true,
    escalated,
    escalation_threshold: ESCALATION_OCCURRENCES,
    authority_fingerprint: fingerprint,
    reconciled_observation_fingerprint: currentObservationFingerprint,
    reconciler_rules_version: RECONCILER_RULES_VERSION,
  }), row.id]);
  return { classification, nextAction, escalated };
}

export async function reconcileRrpLearningQueue({ store, limit = DEFAULT_LIMIT, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!store?.pool || typeof store.listProducts !== "function") {
    return { enabled: false, checked: 0, resolved: 0, conflicts: 0, escalated: 0, deferred: 0, remaining: null };
  }
  const pool = await store.pool();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const candidateLimit = Math.min(2500, Math.max(500, safeLimit * 8));
  const products = await loadAuthorityProducts(pool, store);
  const context = buildRrpValueContext(products);
  const fingerprint = authorityFingerprint(products);

  // Pull a wider recent candidate pool, then let the knowledge layer rank it using
  // live availability, product value family, identifiers, recurrence and evidence
  // across retailers. Escalated rows are only deferred when both authority truth
  // and the latest observed market facts are unchanged.
  const { rows: candidateRows } = await pool.query(`
    SELECT *
    FROM fatedrop_rrp_resolution_queue
    WHERE status IN ('open','candidate')
    ORDER BY last_seen_at DESC, occurrence_count DESC
    LIMIT $1
  `, [candidateLimit]);

  const ranked = rankRrpGapRows(candidateRows, { now });
  const active = [];
  let deferred = 0;
  for (const item of ranked) {
    if (canDeferEscalatedRow(item.row, fingerprint)) {
      deferred += 1;
      continue;
    }
    active.push(item);
    if (active.length >= safeLimit) break;
  }

  let resolved = 0;
  let conflicts = 0;
  let escalated = 0;
  const checkedRows = [];

  for (const { row, intelligence } of active) {
    checkedRows.push(row);
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
          knowledge_priority: intelligence.priority,
          cross_retailer_count: intelligence.crossRetailerCount,
        },
      });
      resolved += 1;
      continue;
    }

    const disposition = await recordUnresolvedDisposition(pool, row, result, now, fingerprint, intelligence);
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
    checked: checkedRows.length,
    candidatePool: candidateRows.length,
    resolved,
    conflicts,
    escalated,
    deferred,
    authorityProducts: context.registry?.authoritativeProducts || 0,
    authorityGraphProducts: products.length,
    remaining: Number(countRows[0]?.remaining || 0),
    knowledge: buildRrpGapSnapshot(candidateRows, { now, limit: 10 }),
  };
}
