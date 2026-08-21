function dbProduct(row) {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    title: row.title,
    productType: row.product_type,
    tcg: row.tcg,
    officialRrpPence: row.official_rrp_pence,
    rrpSource: row.rrp_source,
    rrpObservedAt: row.rrp_observed_at ? Number(row.rrp_observed_at) : null,
    firstSeenAt: Number(row.first_seen_at),
    updatedAt: Number(row.updated_at),
  };
}

function dbOffer(row) {
  return {
    offerId: row.offer_id,
    productId: row.product_id,
    retailerId: row.retailer_id,
    retailerName: row.retailer_name,
    retailerSku: row.retailer_sku,
    title: row.title,
    url: row.url,
    imageUrl: row.image_url,
    pricePence: row.price_pence,
    postagePence: row.postage_pence,
    gtin: row.gtin || null,
    stockStatus: row.stock_status,
    stockConfidence: Number(row.stock_confidence),
    stockQuantity: row.stock_quantity,
    everAvailableAt: row.ever_available_at ? Number(row.ever_available_at) : null,
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

export async function preloadPreviousState(store, identities) {
  if (!store || typeof store.pool !== "function") return null;
  const productIds = [...new Set(identities.map((item) => item.productId).filter(Boolean))];
  const offerIds = [...new Set(identities.map((item) => item.offerId).filter(Boolean))];
  const pool = await store.pool();

  const [productResult, offerResult] = await Promise.all([
    productIds.length
      ? pool.query("SELECT * FROM fatedrop_products WHERE id = ANY($1::text[])", [productIds])
      : { rows: [] },
    offerIds.length
      ? pool.query("SELECT * FROM fatedrop_retail_offers WHERE offer_id = ANY($1::text[])", [offerIds])
      : { rows: [] },
  ]);

  return {
    products: new Map(productResult.rows.map((row) => [row.id, dbProduct(row)])),
    offers: new Map(offerResult.rows.map((row) => [row.offer_id, dbOffer(row)])),
  };
}
