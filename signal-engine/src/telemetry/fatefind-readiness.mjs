import { env } from "../config/env.mjs";
import { evaluateFateFind, notificationDeliveryPlan } from "../hosted/fatefind.mjs";
import { buildFateMatchNotificationReadiness } from "../hosted/notification-readiness.mjs";

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
    notifications: row.notification_preferences_json || {},
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
    lastSeenAt: Number(row.last_seen_at || 0),
  };
}

function rowToProduct(row) {
  return {
    id: row.id,
    title: row.title,
    officialRrpPence: row.official_rrp_pence == null ? null : Number(row.official_rrp_pence),
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

function emptyDelivery() {
  return {
    webReadyFinds: 0,
    pushRequestedFinds: 0,
    pushReadyFinds: 0,
    pushMissingEndpointFinds: 0,
    discordRequestedFinds: 0,
    discordPreferenceEnabledFinds: 0,
    discordReadyFinds: 0,
    discordMissingLinkFinds: 0,
    discordPreferenceDisabledFinds: 0,
  };
}

function preflightBlockers({ storeReady, findsTruncated, offersTruncated, queue, delivery }) {
  const blockers = [];
  if (!storeReady) blockers.push("postgres_store_unavailable");
  if (findsTruncated) blockers.push("fatefind_preflight_truncated");
  if (offersTruncated) blockers.push("offer_preflight_truncated");
  if (queue?.ready === false) blockers.push("fate_match_outbox_not_ready");
  if (delivery.pushRequestedFinds > delivery.pushReadyFinds) blockers.push("requested_push_delivery_not_registered");
  if (delivery.discordRequestedFinds > delivery.discordReadyFinds) blockers.push("requested_discord_delivery_not_ready");
  return blockers;
}

export async function buildHostedFateFindReadiness(store, {
  now = Math.floor(Date.now() / 1000),
  maxFinds = Math.min(env.hostedFateFind.maxFindsPerRun, 200),
  maxOffers = 10_000,
} = {}) {
  const safeMaxFinds = Math.max(1, Math.min(500, Math.trunc(Number(maxFinds) || 200)));
  const safeMaxOffers = Math.max(1, Math.min(10_000, Math.trunc(Number(maxOffers) || 10_000)));
  const storeReady = Boolean(store && typeof store.pool === "function" && env.store === "postgres");
  if (!storeReady) {
    const delivery = emptyDelivery();
    const blockers = preflightBlockers({ storeReady, findsTruncated: false, offersTruncated: false, queue: null, delivery });
    return {
      available: false,
      featureEnabled: env.hostedFateFind.enabled,
      storeReady: false,
      generatedAt: now,
      blockers,
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
    ? await pool.query("SELECT id,title,official_rrp_pence FROM fatedrop_products WHERE id = ANY($1)", [productIds])
    : { rows: [] };
  const products = new Map(productRows.map((row) => [row.id, rowToProduct(row)]));

  const userIds = [...new Set(finds.map((find) => find.userId).filter(Boolean))];
  const [prefsResult, pushResult, discordResult, queue] = await Promise.all([
    userIds.length
      ? pool.query("SELECT * FROM fatedrop_notification_preferences WHERE user_id = ANY($1)", [userIds])
      : Promise.resolve({ rows: [] }),
    userIds.length
      ? pool.query("SELECT user_id,count(*)::int AS enabled_count FROM fatedrop_push_endpoints WHERE user_id = ANY($1) AND enabled=true GROUP BY user_id", [userIds])
      : Promise.resolve({ rows: [] }),
    userIds.length
      ? pool.query("SELECT user_id,count(*)::int AS linked_count FROM fatedrop_discord_links WHERE user_id = ANY($1) GROUP BY user_id", [userIds])
      : Promise.resolve({ rows: [] }),
    buildFateMatchNotificationReadiness(pool, { now }),
  ]);

  const prefsByUser = new Map(prefsResult.rows.map((row) => [row.user_id, row]));
  const pushByUser = new Map(pushResult.rows.map((row) => [row.user_id, Number(row.enabled_count || 0)]));
  const discordByUser = new Map(discordResult.rows.map((row) => [row.user_id, Number(row.linked_count || 0)]));

  let evaluated = 0;
  let wouldMatch = 0;
  const findsWithMatch = new Set();
  const rejectionReasons = new Map();
  for (const find of finds) {
    for (const offer of offers) {
      evaluated += 1;
      const result = evaluateFateFind(find, offer, products.get(offer.productId));
      if (result.matched) {
        wouldMatch += 1;
        findsWithMatch.add(find.id);
      } else {
        increment(rejectionReasons, result.reasons?.[0]);
      }
    }
  }

  const delivery = emptyDelivery();
  for (const find of finds) {
    const prefs = prefsByUser.get(find.userId) || {};
    const plan = notificationDeliveryPlan(prefs, find.notifications, now);
    if (plan.enabled.web) delivery.webReadyFinds += 1;

    if (find.notifications.app === true) {
      delivery.pushRequestedFinds += 1;
      if (plan.enabled.push && (pushByUser.get(find.userId) || 0) > 0) delivery.pushReadyFinds += 1;
      else if (plan.enabled.push) delivery.pushMissingEndpointFinds += 1;
    }

    if (find.notifications.discord === true) {
      delivery.discordRequestedFinds += 1;
      if (plan.enabled.discord) {
        delivery.discordPreferenceEnabledFinds += 1;
        if ((discordByUser.get(find.userId) || 0) > 0) delivery.discordReadyFinds += 1;
        else delivery.discordMissingLinkFinds += 1;
      } else {
        delivery.discordPreferenceDisabledFinds += 1;
      }
    }
  }

  const findsTruncated = totalEligibleFinds > finds.length;
  const offersTruncated = totalPurchasableOffers > offers.length;
  const blockers = preflightBlockers({ storeReady, findsTruncated, offersTruncated, queue, delivery });

  return {
    available: true,
    featureEnabled: env.hostedFateFind.enabled,
    storeReady: true,
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
    delivery,
    queue,
    evaluatorReady: !findsTruncated && !offersTruncated && queue.ready === true,
    betaDeliveryReady: blockers.length === 0,
    blockers,
  };
}
