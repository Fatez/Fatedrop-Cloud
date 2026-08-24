import { env } from "../config/env.mjs";
import { buildRrpValueContext } from "../core/rrp-value-reference.mjs";
import { evaluateFateFind } from "../hosted/fatefind.mjs";

function rowToFind(row) {
  return {
    id: row.id,
    userId: row.user_id,
    queryText: row.query_text || "",
    productIdentityId: row.product_identity_id,
    maxItemPricePence: row.max_item_price_pence == null ? null : Number(row.max_item_price_pence),
    maxTruePricePence: row.max_true_price_pence == null ? null : Number(row.max_true_price_pence),
    maxPercentAboveRrp: row.max_percent_above_rrp == null ? null : Number(row.max_percent_above_rrp),
    scope: row.scope || "either",
    preferredRetailerIds: row.preferred_retailers_json || [],
    excludedRetailerIds: row.excluded_retailers_json || [],
    stockRequirement: row.stock_requirement || "in_stock",
  };
}

function rowToOffer(row) {
  return {
    offerId: row.offer_id,
    productId: row.product_id,
    retailerId: row.retailer_id,
    retailerName: row.retailer_name,
    title: row.title,
    url: row.url,
    pricePence: row.price_pence == null ? null : Number(row.price_pence),
    postagePence: row.postage_pence == null ? null : Number(row.postage_pence),
    stockStatus: row.stock_status,
  };
}

function rowToProduct(row) {
  return {
    id: row.id,
    title: row.title,
    productType: row.product_type || null,
    tcg: row.tcg || "pokemon",
    officialRrpPence: row.official_rrp_pence == null ? null : Number(row.official_rrp_pence),
    rrpSource: row.rrp_source || null,
    rrpObservedAt: row.rrp_observed_at == null ? null : Number(row.rrp_observed_at),
  };
}

function increment(map, key) {
  const clean = String(key || "unknown");
  map.set(clean, (map.get(clean) || 0) + 1);
}

function topReasons(map, limit = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

export async function buildFateFindEvaluatorPreflight(store, {
  now = Math.floor(Date.now() / 1000),
  maxFinds = Math.min(env.hostedFateFind.maxFindsPerRun, 200),
  maxOffers = 10_000,
} = {}) {
  const safeMaxFinds = Math.max(1, Math.min(500, Math.trunc(Number(maxFinds) || 200)));
  const safeMaxOffers = Math.max(1, Math.min(10_000, Math.trunc(Number(maxOffers) || 10_000)));
  if (!store || typeof store.pool !== "function") {
    return {
      available: false,
      featureEnabled: Boolean(env.hostedFateFind.enabled),
      generatedAt: now,
      reason: "persistent_store_unavailable",
    };
  }

  const pool = await store.pool();
  const { rows: findRows } = await pool.query(`
    SELECT f.*, count(*) OVER()::int AS total_eligible
    FROM fatedrop_fate_matches f
    JOIN fatedrop_memberships m ON m.user_id=f.user_id
    WHERE f.enabled=true AND m.tier IN ('plus','pro') AND m.status IN ('active','trialing')
    ORDER BY f.updated_at DESC LIMIT $1
  `, [safeMaxFinds]);
  const totalEligibleFinds = Number(findRows[0]?.total_eligible || 0);
  const finds = findRows.map(rowToFind);

  const { rows: offerRows } = await pool.query(`
    SELECT o.*, count(*) OVER()::int AS total_available
    FROM fatedrop_retail_offers o
    WHERE stock_status IN ('in_stock','low_stock','preorder')
    ORDER BY last_seen_at DESC LIMIT $1
  `, [safeMaxOffers]);
  const totalPurchasableOffers = Number(offerRows[0]?.total_available || 0);
  const offers = offerRows.map(rowToOffer);
  const productIds = [...new Set(offers.map((offer) => offer.productId).filter(Boolean))];
  const { rows: productRows } = productIds.length
    ? await pool.query(
      "SELECT id,title,product_type,tcg,official_rrp_pence,rrp_source,rrp_observed_at FROM fatedrop_products WHERE id = ANY($1) OR (official_rrp_pence IS NOT NULL AND rrp_source IS NOT NULL)",
      [productIds],
    )
    : { rows: [] };
  const normalizedProducts = productRows.map(rowToProduct);
  const products = new Map(normalizedProducts.map((product) => [product.id, product]));
  const rrpContext = buildRrpValueContext(normalizedProducts);

  let evaluated = 0;
  let wouldMatch = 0;
  const findsWithMatch = new Set();
  const rejectionReasons = new Map();
  for (const find of finds) {
    for (const offer of offers) {
      evaluated += 1;
      const result = evaluateFateFind(find, offer, products.get(offer.productId), rrpContext);
      if (result.matched) {
        wouldMatch += 1;
        findsWithMatch.add(find.id);
      } else {
        increment(rejectionReasons, result.reasons?.[0]);
      }
    }
  }

  const findsTruncated = totalEligibleFinds > finds.length;
  const offersTruncated = totalPurchasableOffers > offers.length;
  return {
    available: true,
    featureEnabled: Boolean(env.hostedFateFind.enabled),
    generatedAt: now,
    limits: { maxFinds: safeMaxFinds, maxOffers: safeMaxOffers },
    eligibleFinds: totalEligibleFinds,
    sampledFinds: finds.length,
    findsTruncated,
    purchasableOffers: totalPurchasableOffers,
    sampledOffers: offers.length,
    offersTruncated,
    evaluated,
    wouldMatch,
    findsWithMatch: findsWithMatch.size,
    topRejectionReasons: topReasons(rejectionReasons),
    complete: !findsTruncated && !offersTruncated,
  };
}
