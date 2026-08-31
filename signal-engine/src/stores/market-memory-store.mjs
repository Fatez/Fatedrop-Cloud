import { rrpAliasSignature } from "../core/rrp-learning.mjs";
import { stableId } from "../core/normalize.mjs";
import { normalizeMarketCode } from "../core/market-memory-policy.mjs";

function memoryFromRow(row) {
  if (!row?.product_identity_id || !row?.market_code) return null;
  return {
    productIdentityId: row.product_identity_id,
    marketCode: row.market_code,
    status: row.market_status || row.status || "verified",
    verificationMethod: row.verification_method || null,
    confidence: Number(row.market_confidence ?? row.confidence ?? 0),
    conflictingMarketCode: row.conflicting_market_code || null,
  };
}

function lookupKeys(item, tcg) {
  const raw = item?.raw || item || {};
  return {
    productId: item?.productId || raw.productId || null,
    canonicalKey: raw.canonicalKey || null,
    gtin: String(raw.gtin || "").trim().toLowerCase() || null,
    aliasSignature: rrpAliasSignature({ tcg, title: raw.title, productType: raw.productType }),
    productType: raw.productType || null,
  };
}

export async function preloadCanonicalMarketMemory({ store, prepared = [], tcg = "pokemon" } = {}) {
  const empty = { available: false, byProductId: new Map(), byAlias: new Map(), byGtin: new Map() };
  if (!store?.pool || !prepared.length) return empty;
  const keys = prepared.map((item) => lookupKeys(item, tcg));
  const productIds = [...new Set(keys.map((key) => key.productId).filter(Boolean))];
  const canonicalKeys = [...new Set(keys.map((key) => key.canonicalKey).filter(Boolean))];
  const aliases = [...new Set(keys.map((key) => key.aliasSignature).filter(Boolean))];
  const gtins = [...new Set(keys.map((key) => key.gtin).filter(Boolean))];
  try {
    const pool = await store.pool();
    const [identities, aliasRows, identifierRows] = await Promise.all([
      pool.query(`
        SELECT i.id AS product_identity_id,i.canonical_key,
               m.market_code,m.status AS market_status,m.verification_method,m.confidence AS market_confidence,m.conflicting_market_code
        FROM fatedrop_product_identities i
        LEFT JOIN fatedrop_product_market_memory m ON m.product_identity_id=i.id
        WHERE i.id = ANY($1::text[]) OR (i.tcg=$2 AND i.canonical_key = ANY($3::text[]))
      `, [productIds, tcg, canonicalKeys]),
      pool.query(`
        SELECT a.alias_signature,a.product_type,a.canonical_product_identity_id AS product_identity_id,
               m.market_code,m.status AS market_status,m.verification_method,m.confidence AS market_confidence,m.conflicting_market_code
        FROM fatedrop_product_identity_aliases a
        LEFT JOIN fatedrop_product_market_memory m ON m.product_identity_id=a.canonical_product_identity_id
        WHERE a.tcg=$1 AND a.alias_signature = ANY($2::text[]) AND a.confidence >= 0.99
      `, [tcg, aliases]),
      pool.query(`
        SELECT lower(p.identifier_value) AS identifier_value,p.product_identity_id,
               m.market_code,m.status AS market_status,m.verification_method,m.confidence AS market_confidence,m.conflicting_market_code
        FROM fatedrop_product_identifiers p
        LEFT JOIN fatedrop_product_market_memory m ON m.product_identity_id=p.product_identity_id
        WHERE p.namespace='gtin' AND lower(p.identifier_value) = ANY($1::text[])
          AND (p.verified_at IS NOT NULL OR p.source_role IN ('manufacturer','official_store','authorized_distributor'))
      `, [gtins]),
    ]);
    const byProductId = new Map();
    for (const row of identities.rows || []) {
      const value = { productIdentityId: row.product_identity_id, resolutionKind: "canonical_identity", confidence: 1, memory: memoryFromRow(row) };
      byProductId.set(row.product_identity_id, value);
      if (row.canonical_key) byProductId.set(`key:${row.canonical_key}`, value);
    }
    const byAlias = new Map((aliasRows.rows || []).map((row) => [
      `${row.alias_signature}\u241f${row.product_type || ""}`,
      { productIdentityId: row.product_identity_id, resolutionKind: "verified_alias", confidence: 1, memory: memoryFromRow(row) },
    ]));
    const byGtin = new Map((identifierRows.rows || []).map((row) => [
      row.identifier_value,
      { productIdentityId: row.product_identity_id, resolutionKind: "verified_identifier", confidence: 1, memory: memoryFromRow(row) },
    ]));
    return { available: true, byProductId, byAlias, byGtin };
  } catch (error) {
    console.error("[market-memory] preload unavailable", { error: String(error?.message || error) });
    return empty;
  }
}

export function resolveCanonicalMarketIdentity(context, item, tcg = "pokemon") {
  const keys = lookupKeys(item, tcg);
  const byIdentifier = keys.gtin ? context?.byGtin?.get(keys.gtin) : null;
  if (byIdentifier) return byIdentifier;
  const byAlias = context?.byAlias?.get(`${keys.aliasSignature}\u241f${keys.productType || ""}`);
  if (byAlias) return byAlias;
  const byIdentity = context?.byProductId?.get(keys.productId) || context?.byProductId?.get(`key:${keys.canonicalKey}`);
  if (byIdentity) return byIdentity;
  return {
    productIdentityId: keys.productId,
    resolutionKind: "current_canonical_key",
    confidence: keys.productId && keys.canonicalKey ? 1 : 0,
    memory: null,
  };
}

export async function persistCanonicalMarketActions(store, actions = [], now = Math.floor(Date.now() / 1000)) {
  if (!store?.pool || !actions.length) return { observations: 0, memories: 0, conflicts: 0 };
  const unique = new Map();
  for (const action of actions) {
    const productIdentityId = String(action?.identity?.productIdentityId || "").trim();
    if (!productIdentityId) continue;
    const resolution = action.resolution || {};
    const key = `${productIdentityId}\u241f${resolution.status}\u241f${resolution.marketCode || resolution.candidateMarketCode || "unknown"}`;
    const previous = unique.get(key);
    unique.set(key, { ...action, occurrenceCount: (previous?.occurrenceCount || 0) + 1 });
  }
  const rows = [...unique.values()].map((action) => {
    const resolution = action.resolution || {};
    const observedMarketCode = normalizeMarketCode(resolution.marketCode || resolution.candidateMarketCode);
    const rememberedMarketCode = normalizeMarketCode(action.identity?.memory?.marketCode || action.identity?.memory?.market_code);
    const rememberedConflictingMarketCode = normalizeMarketCode(action.identity?.memory?.conflictingMarketCode || action.identity?.memory?.conflicting_market_code);
    const claimMarketCodes = [...new Set((resolution.evidence || [])
      .map((claim) => normalizeMarketCode(claim?.marketCode))
      .filter(Boolean))];
    const authoritativeClaimCodes = [...new Set((resolution.evidence || [])
      .filter((claim) => claim?.authority === "authoritative")
      .map((claim) => normalizeMarketCode(claim?.marketCode))
      .filter(Boolean))];
    const conflictMemoryCodes = [...new Set([
      rememberedMarketCode,
      rememberedConflictingMarketCode,
      ...claimMarketCodes,
      normalizeMarketCode(resolution.candidateMarketCode),
    ].filter(Boolean))];
    return {
      id: stableId("mktobs", action.identity.productIdentityId, action.retailerId || "", action.offerId || "", resolution.status || "unknown", observedMarketCode || "unknown"),
      productIdentityId: action.identity.productIdentityId,
      offerId: action.offerId || null,
      retailerId: action.retailerId || null,
      observedTitle: action.title || "",
      observedMarketCode,
      resolutionStatus: resolution.status || "unknown",
      resolutionSource: resolution.source || "unknown",
      confidence: Number(resolution.confidence) || 0,
      identityResolutionKind: action.identity.resolutionKind || "unknown",
      firstSeenAt: action.observedAt || now,
      lastSeenAt: action.observedAt || now,
      occurrenceCount: action.occurrenceCount || 1,
      evidence: { claims: resolution.evidence || [], identityConfidence: action.identity.confidence ?? null },
      conflictMemoryCodes,
      conflictPersistable: resolution.status === "conflict"
        && (rememberedMarketCode != null || authoritativeClaimCodes.length > 0)
        && conflictMemoryCodes.length > 1,
    };
  });
  if (!rows.length) return { observations: 0, memories: 0, conflicts: 0 };
  const memoryGroups = new Map();
  for (const row of rows) {
    const verified = ["verified", "reused"].includes(row.resolutionStatus) && row.observedMarketCode;
    if (!verified && !row.conflictPersistable) continue;
    const group = memoryGroups.get(row.productIdentityId) || [];
    group.push(row);
    memoryGroups.set(row.productIdentityId, group);
  }
  const memoryRows = [...memoryGroups.values()].map((group) => {
    const marketCodes = [...new Set(group.flatMap((row) => row.conflictPersistable
      ? row.conflictMemoryCodes
      : [row.observedMarketCode]).filter(Boolean))].sort();
    const first = group[0];
    const conflict = group.some((row) => row.conflictPersistable) || marketCodes.length > 1;
    return {
      ...first,
      observedMarketCode: marketCodes[0],
      conflictingMarketCode: conflict ? marketCodes[1] : null,
      memoryStatus: conflict ? "conflict" : "verified",
      resolutionSource: conflict ? "batch_authoritative_market_conflict" : first.resolutionSource,
      confidence: conflict ? 0 : Math.max(...group.map((row) => row.confidence)),
      firstSeenAt: Math.min(...group.map((row) => row.firstSeenAt)),
      lastSeenAt: Math.max(...group.map((row) => row.lastSeenAt)),
      occurrenceCount: group.reduce((sum, row) => sum + row.occurrenceCount, 0),
      evidence: { claims: group.flatMap((row) => row.evidence?.claims || []), identityConfidence: first.evidence?.identityConfidence ?? null },
    };
  });
  const pool = await store.pool();
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  let observations = 0;
  let memories = 0;
  let conflicts = 0;
  try {
    if (client !== pool) await client.query("BEGIN");
    const observationResult = await client.query(`
      INSERT INTO fatedrop_product_market_observations (
        id,product_identity_id,offer_id,retailer_id,observed_title,observed_market_code,
        resolution_status,resolution_source,confidence,identity_resolution_kind,
        first_seen_at,last_seen_at,occurrence_count,evidence_json
      )
      SELECT x->>'id',x->>'productIdentityId',NULLIF(x->>'offerId',''),NULLIF(x->>'retailerId',''),x->>'observedTitle',
             NULLIF(x->>'observedMarketCode',''),x->>'resolutionStatus',x->>'resolutionSource',(x->>'confidence')::numeric,
             x->>'identityResolutionKind',(x->>'firstSeenAt')::bigint,(x->>'lastSeenAt')::bigint,(x->>'occurrenceCount')::int,
             COALESCE(x->'evidence','{}'::jsonb)
      FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT (id) DO UPDATE SET
        last_seen_at=GREATEST(fatedrop_product_market_observations.last_seen_at,EXCLUDED.last_seen_at),
        occurrence_count=fatedrop_product_market_observations.occurrence_count+EXCLUDED.occurrence_count,
        evidence_json=fatedrop_product_market_observations.evidence_json || EXCLUDED.evidence_json
    `, [JSON.stringify(rows)]);
    observations = Number(observationResult.rowCount || 0);
    if (memoryRows.length) {
      const memoryResult = await client.query(`
        INSERT INTO fatedrop_product_market_memory (
          product_identity_id,market_code,status,verification_method,confidence,
          first_seen_at,last_seen_at,verified_at,occurrence_count,conflicting_market_code,
          conflict_detected_at,evidence_json
        )
        SELECT x->>'productIdentityId',x->>'observedMarketCode',x->>'memoryStatus',x->>'resolutionSource',(x->>'confidence')::numeric,
               (x->>'firstSeenAt')::bigint,(x->>'lastSeenAt')::bigint,(x->>'lastSeenAt')::bigint,
               (x->>'occurrenceCount')::int,NULLIF(x->>'conflictingMarketCode',''),
               CASE WHEN x->>'memoryStatus'='conflict' THEN (x->>'lastSeenAt')::bigint ELSE NULL END,
               COALESCE(x->'evidence','{}'::jsonb)
        FROM jsonb_array_elements($1::jsonb) x
        ON CONFLICT (product_identity_id) DO UPDATE SET
          status=CASE
            WHEN fatedrop_product_market_memory.status='conflict' OR EXCLUDED.status='conflict' THEN 'conflict'
            WHEN fatedrop_product_market_memory.market_code=EXCLUDED.market_code THEN 'verified'
            ELSE 'conflict'
          END,
          conflicting_market_code=CASE
            WHEN EXCLUDED.status='conflict' THEN EXCLUDED.conflicting_market_code
            WHEN fatedrop_product_market_memory.market_code<>EXCLUDED.market_code THEN EXCLUDED.market_code
            ELSE fatedrop_product_market_memory.conflicting_market_code
          END,
          conflict_detected_at=CASE
            WHEN EXCLUDED.status='conflict' THEN EXCLUDED.conflict_detected_at
            WHEN fatedrop_product_market_memory.market_code<>EXCLUDED.market_code THEN EXCLUDED.last_seen_at
            ELSE fatedrop_product_market_memory.conflict_detected_at
          END,
          last_seen_at=GREATEST(fatedrop_product_market_memory.last_seen_at,EXCLUDED.last_seen_at),
          occurrence_count=fatedrop_product_market_memory.occurrence_count+EXCLUDED.occurrence_count,
          evidence_json=fatedrop_product_market_memory.evidence_json || EXCLUDED.evidence_json
        RETURNING status
      `, [JSON.stringify(memoryRows)]);
      memories = Number(memoryResult.rowCount || 0);
      conflicts = (memoryResult.rows || []).filter((row) => row.status === "conflict").length;
    }
    if (client !== pool) await client.query("COMMIT");
  } catch (error) {
    if (client !== pool) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    if (client !== pool) client.release();
  }
  return { observations, memories, conflicts };
}
