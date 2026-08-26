export async function recordUnresolvedRrp(pool, row) {
  if (!pool || !row) return null;
  const { rows } = await pool.query(`
    INSERT INTO fatedrop_rrp_resolution_queue (
      id, tcg, product_id, offer_id, retailer_id, observed_title, product_type,
      language_code, region_code, failure_reason, status, occurrence_count,
      first_seen_at, last_seen_at, evidence_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',1,$11,$11,$12::jsonb)
    ON CONFLICT (retailer_id, observed_title, COALESCE(product_type,''))
    DO UPDATE SET
      product_id=COALESCE(EXCLUDED.product_id,fatedrop_rrp_resolution_queue.product_id),
      offer_id=COALESCE(EXCLUDED.offer_id,fatedrop_rrp_resolution_queue.offer_id),
      failure_reason=EXCLUDED.failure_reason,
      occurrence_count=fatedrop_rrp_resolution_queue.occurrence_count + 1,
      last_seen_at=GREATEST(fatedrop_rrp_resolution_queue.last_seen_at,EXCLUDED.last_seen_at),
      evidence_json=fatedrop_rrp_resolution_queue.evidence_json || EXCLUDED.evidence_json
    RETURNING *
  `, [
    row.id, row.tcg || "pokemon", row.productId || null, row.offerId || null,
    row.retailerId, row.observedTitle, row.productType || null, row.languageCode || null,
    row.regionCode || null, row.failureReason, row.observedAt, JSON.stringify(row.evidence || {}),
  ]);
  return rows[0] || null;
}

export async function findVerifiedRrpAlias(pool, { tcg = "pokemon", aliasSignature, productType = null } = {}) {
  if (!pool || !aliasSignature) return null;
  const { rows } = await pool.query(`
    SELECT a.*, i.official_rrp_pence, i.rrp_source, i.rrp_verified_at, i.title AS canonical_title
    FROM fatedrop_product_identity_aliases a
    JOIN fatedrop_product_identities i ON i.id=a.canonical_product_identity_id
    WHERE a.tcg=$1 AND a.alias_signature=$2 AND COALESCE(a.product_type,'')=COALESCE($3,'')
      AND a.confidence >= 0.99
      AND i.official_rrp_pence IS NOT NULL
    LIMIT 1
  `, [tcg, aliasSignature, productType]);
  return rows[0] || null;
}

export async function recordVerifiedRrpAlias(pool, row) {
  if (!pool || !row) return null;
  const { rows } = await pool.query(`
    INSERT INTO fatedrop_product_identity_aliases (
      id, tcg, alias_signature, observed_title, product_type, canonical_product_identity_id,
      resolution_kind, confidence, source, first_seen_at, last_seen_at, verified_at,
      occurrence_count, evidence_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,1,$11::jsonb)
    ON CONFLICT (tcg, alias_signature, COALESCE(product_type,''))
    DO UPDATE SET
      canonical_product_identity_id=EXCLUDED.canonical_product_identity_id,
      confidence=GREATEST(fatedrop_product_identity_aliases.confidence,EXCLUDED.confidence),
      source=EXCLUDED.source,
      last_seen_at=GREATEST(fatedrop_product_identity_aliases.last_seen_at,EXCLUDED.last_seen_at),
      verified_at=GREATEST(fatedrop_product_identity_aliases.verified_at,EXCLUDED.verified_at),
      occurrence_count=fatedrop_product_identity_aliases.occurrence_count + 1,
      evidence_json=fatedrop_product_identity_aliases.evidence_json || EXCLUDED.evidence_json
    RETURNING *
  `, [
    row.id, row.tcg || "pokemon", row.aliasSignature, row.observedTitle, row.productType || null,
    row.canonicalProductIdentityId, row.resolutionKind || "verified_alias", row.confidence ?? 1,
    row.source || "rrp-resolver", row.verifiedAt, JSON.stringify(row.evidence || {}),
  ]);
  await pool.query(`
    UPDATE fatedrop_rrp_resolution_queue
    SET status='resolved', candidate_identity_id=$1, candidate_confidence=$2,
        resolved_at=$3, resolution_source=$4
    WHERE retailer_id=$5 AND observed_title=$6 AND COALESCE(product_type,'')=COALESCE($7,'')
  `, [row.canonicalProductIdentityId, row.confidence ?? 1, row.verifiedAt, row.source || "rrp-resolver", row.retailerId || "", row.observedTitle, row.productType || null]);
  return rows[0] || null;
}
