function uniqueRecords(records) {
  const byOffer = new Map();
  for (const record of records || []) {
    if (!record?.offer?.offerId || !record?.mapping?.cardIdentityId) throw new TypeError('Every retail-single record requires an offer and exact card mapping');
    const existing = byOffer.get(record.offer.offerId);
    if (existing && existing.mapping.cardIdentityId !== record.mapping.cardIdentityId) {
      throw new TypeError(`Conflicting card identities for offer ${record.offer.offerId}`);
    }
    byOffer.set(record.offer.offerId, record);
  }
  return [...byOffer.values()].sort((a, b) => a.offer.offerId.localeCompare(b.offer.offerId));
}

function splitConflicts(records, existingMappings) {
  const existingByOffer = new Map(
    (existingMappings || [])
      .filter((mapping) => mapping?.verificationStatus === 'verified')
      .map((mapping) => [mapping.offerId, mapping.cardIdentityId]),
  );
  const accepted = [];
  const conflicts = [];
  for (const record of records) {
    const currentCardId = existingByOffer.get(record.offer.offerId);
    if (currentCardId && currentCardId !== record.mapping.cardIdentityId) {
      conflicts.push(Object.freeze({
        offerId: record.offer.offerId,
        existingCardIdentityId: currentCardId,
        candidateCardIdentityId: record.mapping.cardIdentityId,
        reason: 'verified_offer_identity_conflict',
      }));
      continue;
    }
    accepted.push(record);
  }
  return { accepted, conflicts };
}

async function persistFile(store, { retailer, records, observedAt }) {
  return store.mutate((state) => {
    state.products ||= {};
    state.offers ||= {};
    state.observations ||= [];
    state.fatePriceRetailOfferMappings ||= {};
    state.retailers ||= {};
    const existingMappings = Object.values(state.fatePriceRetailOfferMappings);
    const { accepted, conflicts } = splitConflicts(records, existingMappings);
    const observationIds = new Set(state.observations.map((item) => item.id));
    for (const record of accepted) {
      state.products[record.product.id] = { ...(state.products[record.product.id] || {}), ...record.product };
      const current = state.offers[record.offer.offerId];
      if (!current || Number(record.offer.lastSeenAt) >= Number(current.lastSeenAt || 0)) {
        state.offers[record.offer.offerId] = { ...(current || {}), ...record.offer };
      }
      if (!observationIds.has(record.observation.id)) {
        state.observations.push(record.observation);
        observationIds.add(record.observation.id);
      }
      state.fatePriceRetailOfferMappings[record.mapping.id] = record.mapping;
    }
    state.retailers[retailer.id] = {
      ...(state.retailers[retailer.id] || {}),
      id: retailer.id,
      name: retailer.name,
      healthy: true,
      stale: false,
      lastScanAt: observedAt,
      lastSuccessAt: observedAt,
    };
    return Object.freeze({
      attempted: records.length,
      persisted: accepted.length,
      conflicts: Object.freeze(conflicts),
      productsSaved: accepted.length,
      offersSaved: accepted.length,
      mappingsSaved: accepted.length,
      observationsSaved: accepted.length,
    });
  });
}

async function bulkJson(client, sql, rows) {
  if (rows.length) await client.query(sql, [JSON.stringify(rows)]);
}

async function persistPostgres(store, { retailer, records, observedAt, pagesScanned, productsSeen }) {
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fatedrop:retail-singles:${retailer.id}`]);
    const offerIds = records.map((record) => record.offer.offerId);
    const existing = offerIds.length
      ? await client.query(`SELECT offer_id,card_identity_id,verification_status
          FROM fatedrop_card_retail_offer_mappings
          WHERE offer_id=ANY($1::text[]) AND verification_status='verified'`, [offerIds])
      : { rows: [] };
    const { accepted, conflicts } = splitConflicts(records, existing.rows.map((row) => ({
      offerId: row.offer_id,
      cardIdentityId: row.card_identity_id,
      verificationStatus: row.verification_status,
    })));

    await bulkJson(client, `INSERT INTO fatedrop_products
      (id,canonical_key,title,product_type,tcg,official_rrp_pence,rrp_source,rrp_observed_at,first_seen_at,updated_at)
      SELECT x->>'id',x->>'canonicalKey',x->>'title',x->>'productType',x->>'tcg',NULL,NULL,NULL,
        (x->>'firstSeenAt')::bigint,(x->>'updatedAt')::bigint
      FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT (id) DO UPDATE SET updated_at=GREATEST(fatedrop_products.updated_at,EXCLUDED.updated_at)`, accepted.map((record) => record.product));

    await bulkJson(client, `INSERT INTO fatedrop_retail_offers
      (offer_id,product_id,retailer_id,retailer_name,retailer_sku,title,url,image_url,price_pence,postage_pence,stock_status,stock_confidence,stock_quantity,ever_available_at,first_seen_at,last_seen_at)
      SELECT x->>'offerId',x->>'productId',x->>'retailerId',x->>'retailerName',x->>'retailerSku',x->>'title',x->>'url',
        NULLIF(x->>'imageUrl',''),NULLIF(x->>'pricePence','')::integer,NULLIF(x->>'postagePence','')::integer,x->>'stockStatus',
        (x->>'stockConfidence')::numeric,NULLIF(x->>'stockQuantity','')::integer,NULLIF(x->>'everAvailableAt','')::bigint,
        (x->>'firstSeenAt')::bigint,(x->>'lastSeenAt')::bigint
      FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT (offer_id) DO UPDATE SET
        product_id=EXCLUDED.product_id,title=EXCLUDED.title,url=EXCLUDED.url,
        image_url=COALESCE(EXCLUDED.image_url,fatedrop_retail_offers.image_url),
        price_pence=EXCLUDED.price_pence,stock_status=EXCLUDED.stock_status,stock_confidence=EXCLUDED.stock_confidence,
        stock_quantity=EXCLUDED.stock_quantity,ever_available_at=COALESCE(fatedrop_retail_offers.ever_available_at,EXCLUDED.ever_available_at),
        last_seen_at=EXCLUDED.last_seen_at
      WHERE EXCLUDED.last_seen_at>=fatedrop_retail_offers.last_seen_at`, accepted.map((record) => record.offer));

    await bulkJson(client, `INSERT INTO fatedrop_stock_observations
      (id,offer_id,retailer_id,observed_at,stock_status,stock_confidence,stock_quantity,price_pence,evidence)
      SELECT x->>'id',x->>'offerId',x->>'retailerId',(x->>'observedAt')::bigint,x->>'stockStatus',
        (x->>'stockConfidence')::numeric,NULLIF(x->>'stockQuantity','')::integer,NULLIF(x->>'pricePence','')::integer,
        COALESCE(x->'evidence','[]'::jsonb)
      FROM jsonb_array_elements($1::jsonb) x ON CONFLICT DO NOTHING`, accepted.map((record) => record.observation));

    await bulkJson(client, `INSERT INTO fatedrop_card_retail_offer_mappings
      (id,card_identity_id,offer_id,market_segment_key,condition_code,language_code,verification_status,verified_at,evidence,created_at,updated_at)
      SELECT x->>'id',x->>'cardIdentityId',x->>'offerId',x->>'marketSegmentKey',x->>'conditionCode',x->>'languageCode',
        'verified',(x->>'verifiedAt')::bigint,COALESCE(x->'evidence','[]'::jsonb),(x->>'createdAt')::bigint,(x->>'updatedAt')::bigint
      FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT (card_identity_id,offer_id) DO UPDATE SET
        market_segment_key=EXCLUDED.market_segment_key,condition_code=EXCLUDED.condition_code,language_code=EXCLUDED.language_code,
        verification_status='verified',verified_at=EXCLUDED.verified_at,evidence=EXCLUDED.evidence,updated_at=EXCLUDED.updated_at`, accepted.map((record) => record.mapping));

    await client.query(`INSERT INTO fatedrop_retailer_health
      (retailer_id,retailer_name,healthy,last_scan_at,last_success_at,last_error,last_error_at,products_seen,pages_scanned,baseline_completed)
      VALUES ($1,$2,true,$3,$3,NULL,NULL,$4,$5,true)
      ON CONFLICT (retailer_id) DO UPDATE SET retailer_name=EXCLUDED.retailer_name,healthy=true,last_scan_at=EXCLUDED.last_scan_at,
        last_success_at=EXCLUDED.last_success_at,last_error=NULL,products_seen=EXCLUDED.products_seen,pages_scanned=EXCLUDED.pages_scanned,
        baseline_completed=true`, [retailer.id, retailer.name, observedAt, productsSeen, pagesScanned]);
    await client.query('COMMIT');
    return Object.freeze({
      attempted: records.length,
      persisted: accepted.length,
      conflicts: Object.freeze(conflicts),
      productsSaved: accepted.length,
      offersSaved: accepted.length,
      mappingsSaved: accepted.length,
      observationsSaved: accepted.length,
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function persistVerifiedRetailSingleRecords(store, {
  retailer,
  records,
  observedAt,
  pagesScanned = 0,
  productsSeen = 0,
} = {}) {
  if (!retailer?.id || !retailer?.name) throw new TypeError('retailer is required');
  const unique = uniqueRecords(records || []);
  if (typeof store?.mutate === 'function') return persistFile(store, { retailer, records: unique, observedAt });
  if (typeof store?.pool === 'function') return persistPostgres(store, { retailer, records: unique, observedAt, pagesScanned, productsSeen });
  throw new TypeError('Retail-single persistence is unavailable');
}

export const __test = Object.freeze({ splitConflicts, uniqueRecords });
