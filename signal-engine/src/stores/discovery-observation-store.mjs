import { persistCanonicalSignals } from "./canonical-signal-ledger.mjs";
import { applyFileCanonicalSignals } from "./file-store.mjs";

function sortedBy(items, key) {
  return [...(items || [])].sort((a, b) => String(a?.[key] || "").localeCompare(String(b?.[key] || "")));
}

function uniqueBy(items, key) {
  const unique = new Map();
  for (const item of items || []) unique.set(String(item?.[key] || ""), item);
  return [...unique.values()];
}

function latestSignalByOffer(signals = []) {
  const latest = new Map();
  for (const signal of [...signals].sort((a, b) => Number(b?.detectedAt || 0) - Number(a?.detectedAt || 0))) {
    const offerId = String(signal?.offerId || "");
    if (offerId && !latest.has(offerId)) latest.set(offerId, signal);
  }
  return latest;
}

function acceptedTransitions(existingLatest, incomingSignals) {
  const latest = new Map(existingLatest);
  const accepted = [];
  let deduplicated = 0;
  for (const signal of [...incomingSignals].sort((a, b) => Number(a?.detectedAt || 0) - Number(b?.detectedAt || 0))) {
    const offerId = String(signal?.offerId || "");
    const previous = offerId ? latest.get(offerId) : null;
    if (previous?.state === signal?.state) {
      deduplicated += 1;
      continue;
    }
    accepted.push(signal);
    if (offerId) latest.set(offerId, signal);
  }
  return { accepted, deduplicated };
}

async function bulkJson(client, sql, rows) {
  if (!rows?.length) return;
  await client.query(sql, [JSON.stringify(rows)]);
}

async function savePostgres(store, { retailer, products, offers, observations, signals }) {
  const pool = await store.pool();
  const client = await pool.connect();
  const orderedProducts = sortedBy(uniqueBy(products, "id"), "id");
  const orderedOffers = sortedBy(uniqueBy(offers, "offerId"), "offerId");
  const orderedObservations = sortedBy(uniqueBy(observations, "id"), "id");
  const orderedSignals = sortedBy(uniqueBy(signals, "id"), "id");
  const offerIds = [...new Set(orderedSignals.map((signal) => signal.offerId).filter(Boolean))];

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fatedrop:save:${retailer.id}`]);

    const existingLatest = new Map();
    if (offerIds.length) {
      const { rows } = await client.query(`
        SELECT DISTINCT ON (offer_id) offer_id, state, detected_at
        FROM fatedrop_signals
        WHERE offer_id = ANY($1::text[])
        ORDER BY offer_id, detected_at DESC
      `, [offerIds]);
      for (const row of rows) existingLatest.set(row.offer_id, { offerId: row.offer_id, state: row.state, detectedAt: Number(row.detected_at) });
    }

    const transitions = acceptedTransitions(existingLatest, orderedSignals);

    await bulkJson(client, `INSERT INTO fatedrop_products (id,canonical_key,title,product_type,tcg,official_rrp_pence,rrp_source,rrp_observed_at,first_seen_at,updated_at)
      SELECT x->>'id',x->>'canonicalKey',x->>'title',x->>'productType',x->>'tcg',NULLIF(x->>'officialRrpPence','')::integer,NULLIF(x->>'rrpSource',''),NULLIF(x->>'rrpObservedAt','')::bigint,(x->>'firstSeenAt')::bigint,(x->>'updatedAt')::bigint
      FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT (id) DO UPDATE SET title=fatedrop_products.title, official_rrp_pence=COALESCE(EXCLUDED.official_rrp_pence,fatedrop_products.official_rrp_pence), rrp_source=COALESCE(EXCLUDED.rrp_source,fatedrop_products.rrp_source), rrp_observed_at=COALESCE(EXCLUDED.rrp_observed_at,fatedrop_products.rrp_observed_at), updated_at=GREATEST(EXCLUDED.updated_at,fatedrop_products.updated_at)`, orderedProducts);

    await bulkJson(client, `INSERT INTO fatedrop_product_identities (id,tcg,canonical_key,title,product_type,official_rrp_pence,rrp_source,rrp_verified_at,updated_at)
      SELECT x->>'id',x->>'tcg',x->>'canonicalKey',x->>'title',NULLIF(x->>'productType',''),NULLIF(x->>'officialRrpPence','')::bigint,NULLIF(x->>'rrpSource',''),NULLIF(x->>'rrpObservedAt','')::bigint,(x->>'updatedAt')::bigint
      FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT (tcg,canonical_key) DO UPDATE SET title=fatedrop_product_identities.title, product_type=COALESCE(fatedrop_product_identities.product_type,EXCLUDED.product_type), official_rrp_pence=COALESCE(EXCLUDED.official_rrp_pence,fatedrop_product_identities.official_rrp_pence), rrp_source=COALESCE(EXCLUDED.rrp_source,fatedrop_product_identities.rrp_source), rrp_verified_at=COALESCE(EXCLUDED.rrp_verified_at,fatedrop_product_identities.rrp_verified_at), updated_at=GREATEST(EXCLUDED.updated_at,fatedrop_product_identities.updated_at)`, orderedProducts);

    await bulkJson(client, `INSERT INTO fatedrop_retail_offers (offer_id,product_id,retailer_id,retailer_name,retailer_sku,title,url,image_url,price_pence,postage_pence,gtin,stock_status,stock_confidence,stock_quantity,ever_available_at,first_seen_at,last_seen_at)
      SELECT x->>'offerId',x->>'productId',x->>'retailerId',x->>'retailerName',x->>'retailerSku',x->>'title',x->>'url',NULLIF(x->>'imageUrl',''),NULLIF(x->>'pricePence','')::integer,NULLIF(x->>'postagePence','')::integer,NULLIF(x->>'gtin',''),x->>'stockStatus',NULLIF(x->>'stockConfidence','')::numeric,NULLIF(x->>'stockQuantity','')::integer,NULLIF(x->>'everAvailableAt','')::bigint,(x->>'firstSeenAt')::bigint,(x->>'lastSeenAt')::bigint
      FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT (offer_id) DO UPDATE SET product_id=EXCLUDED.product_id,title=EXCLUDED.title,url=CASE WHEN EXCLUDED.url <> '' THEN EXCLUDED.url ELSE fatedrop_retail_offers.url END,image_url=COALESCE(EXCLUDED.image_url,fatedrop_retail_offers.image_url),price_pence=COALESCE(EXCLUDED.price_pence,fatedrop_retail_offers.price_pence),postage_pence=COALESCE(EXCLUDED.postage_pence,fatedrop_retail_offers.postage_pence),gtin=COALESCE(EXCLUDED.gtin,fatedrop_retail_offers.gtin),stock_status=EXCLUDED.stock_status,stock_confidence=EXCLUDED.stock_confidence,stock_quantity=EXCLUDED.stock_quantity,ever_available_at=COALESCE(fatedrop_retail_offers.ever_available_at,EXCLUDED.ever_available_at),last_seen_at=GREATEST(EXCLUDED.last_seen_at,fatedrop_retail_offers.last_seen_at)
      WHERE EXCLUDED.last_seen_at >= fatedrop_retail_offers.last_seen_at`, orderedOffers);

    await bulkJson(client, `INSERT INTO fatedrop_stock_observations (id,offer_id,retailer_id,observed_at,stock_status,stock_confidence,stock_quantity,price_pence,evidence)
      SELECT x->>'id',x->>'offerId',x->>'retailerId',(x->>'observedAt')::bigint,x->>'stockStatus',NULLIF(x->>'stockConfidence','')::numeric,NULLIF(x->>'stockQuantity','')::integer,NULLIF(x->>'pricePence','')::integer,COALESCE(x->'evidence','[]'::jsonb)
      FROM jsonb_array_elements($1::jsonb) x ON CONFLICT DO NOTHING`, orderedObservations);

    const signalPersistence = await persistCanonicalSignals(client, transitions.accepted);

    await client.query("COMMIT");
    return {
      ...signalPersistence,
      insertedSignalIds: signalPersistence.acceptedSignalIds,
      deduplicatedSignals: transitions.deduplicated + signalPersistence.deduplicatedSignalIds.length,
      productsSaved: orderedProducts.length,
      offersSaved: orderedOffers.length,
      observationsSaved: orderedObservations.length,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function saveFile(store, { products, offers, observations, signals }) {
  return store.mutate((state) => {
    state.products ||= {};
    state.offers ||= {};
    state.observations ||= [];
    state.signals ||= [];

    const existingLatest = latestSignalByOffer(state.signals);
    const transitions = acceptedTransitions(existingLatest, uniqueBy(signals, "id"));

    for (const product of uniqueBy(products, "id")) {
      const existing = state.products[product.id];
      state.products[product.id] = existing
        ? {
          ...existing,
          officialRrpPence: product.officialRrpPence ?? existing.officialRrpPence,
          rrpSource: product.rrpSource ?? existing.rrpSource,
          rrpObservedAt: product.rrpObservedAt ?? existing.rrpObservedAt,
          updatedAt: Math.max(Number(existing.updatedAt || 0), Number(product.updatedAt || 0)),
        }
        : product;
    }

    for (const offer of uniqueBy(offers, "offerId")) {
      const existing = state.offers[offer.offerId];
      if (!existing || Number(offer.lastSeenAt || 0) >= Number(existing.lastSeenAt || 0)) {
        state.offers[offer.offerId] = {
          ...(existing || {}),
          ...offer,
          url: offer.url || existing?.url || "",
          imageUrl: offer.imageUrl || existing?.imageUrl || null,
          pricePence: offer.pricePence ?? existing?.pricePence ?? null,
          postagePence: offer.postagePence ?? existing?.postagePence ?? null,
          gtin: offer.gtin || existing?.gtin || null,
          everAvailableAt: existing?.everAvailableAt ?? offer.everAvailableAt ?? null,
        };
      }
    }

    const observationIds = new Set(state.observations.map((item) => item.id));
    for (const observation of observations || []) if (!observationIds.has(observation.id)) state.observations.push(observation);
    const signalPersistence = applyFileCanonicalSignals(state, transitions.accepted);
    if (state.observations.length > 100000) state.observations = state.observations.slice(-100000);

    return {
      ...signalPersistence,
      insertedSignalIds: signalPersistence.acceptedSignalIds,
      deduplicatedSignals: transitions.deduplicated + signalPersistence.deduplicatedSignalIds.length,
      productsSaved: (products || []).length,
      offersSaved: (offers || []).length,
      observationsSaved: (observations || []).length,
    };
  });
}

export async function saveDiscoveryObservationBatch(store, payload) {
  if (typeof store?.pool === "function") return savePostgres(store, payload);
  if (typeof store?.mutate === "function") return saveFile(store, payload);
  throw new Error("Store does not support additive discovery observation persistence");
}
