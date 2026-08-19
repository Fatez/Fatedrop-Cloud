import crypto from "node:crypto";

function normalized(value = "") {
  return String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function queryMatches(query, title) {
  const wanted = normalized(query).split(" ").filter(Boolean);
  const haystack = normalized(title);
  return wanted.length > 0 && wanted.every((token) => haystack.includes(token));
}

function deliveredPence(offer) {
  if (!Number.isFinite(offer.pricePence) || !Number.isFinite(offer.postagePence)) return null;
  return offer.pricePence + offer.postagePence;
}

function percentAboveRrp(pricePence, rrpPence) {
  if (!Number.isFinite(pricePence) || !Number.isFinite(rrpPence) || rrpPence <= 0) return null;
  return Math.round((((pricePence - rrpPence) / rrpPence) * 100) * 10) / 10;
}

function purchasable(status) {
  return status === "in_stock" || status === "low_stock" || status === "preorder";
}

function parseMinuteOfDay(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function localMinuteOfDay(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone || "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now * 1000));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

function quietHoursDelaySeconds(prefs, now) {
  if (prefs.quiet_hours_enabled !== true) return 0;
  const start = parseMinuteOfDay(prefs.quiet_hours_start);
  const end = parseMinuteOfDay(prefs.quiet_hours_end);
  const current = localMinuteOfDay(now, prefs.timezone || "Europe/London");
  if (start === null || end === null || current === null || start === end) return 0;

  if (start < end) {
    if (current < start || current >= end) return 0;
    return (end - current) * 60;
  }

  if (current >= start) return ((24 * 60 - current) + end) * 60;
  if (current < end) return (end - current) * 60;
  return 0;
}

export function notificationDeliveryPlan(prefs = {}, findNotifications = {}, now = Math.floor(Date.now() / 1000)) {
  const fateMatchEnabled = prefs.fate_match_enabled !== false;
  const enabled = {
    web: fateMatchEnabled && prefs.web_enabled !== false && findNotifications.website !== false,
    push: fateMatchEnabled && prefs.push_enabled !== false && findNotifications.app === true,
    discord: fateMatchEnabled && prefs.discord_enabled === true && findNotifications.discord === true,
  };
  const quietDelay = quietHoursDelaySeconds(prefs, now);
  return {
    enabled,
    nextAttemptAt: {
      web: now,
      push: enabled.push && quietDelay > 0 ? now + quietDelay : now,
      discord: enabled.discord && quietDelay > 0 ? now + quietDelay : now,
    },
    quietUntil: quietDelay > 0 ? now + quietDelay : null,
  };
}

export function evaluateFateFind(find, offer, product) {
  const reasons = [];
  const title = product?.title || offer.title || "";
  if (find.productIdentityId && find.productIdentityId === product?.id) reasons.push("product-identity");
  else if (!queryMatches(find.queryText, title)) return { matched: false, reasons: ["query-mismatch"] };
  else reasons.push("query");

  if (find.preferredRetailerIds.length && !find.preferredRetailerIds.includes(offer.retailerId)) return { matched: false, reasons: ["retailer-not-preferred"] };
  if (find.excludedRetailerIds.includes(offer.retailerId)) return { matched: false, reasons: ["retailer-excluded"] };

  if (find.stockRequirement === "in_stock" && !["in_stock", "low_stock"].includes(offer.stockStatus)) return { matched: false, reasons: ["stock-not-in-stock"] };
  if (find.stockRequirement === "purchasable" && !purchasable(offer.stockStatus)) return { matched: false, reasons: ["stock-not-purchasable"] };
  reasons.push(`stock:${offer.stockStatus}`);

  if (Number.isFinite(find.maxItemPricePence)) {
    if (!Number.isFinite(offer.pricePence) || offer.pricePence > find.maxItemPricePence) return { matched: false, reasons: ["item-price-above-limit"] };
    reasons.push("item-price");
  }

  const delivered = deliveredPence(offer);
  if (Number.isFinite(find.maxTruePricePence)) {
    if (!Number.isFinite(delivered)) return { matched: false, reasons: ["delivery-unknown"] };
    if (delivered > find.maxTruePricePence) return { matched: false, reasons: ["true-price-above-limit"] };
    reasons.push("true-price");
  }

  const premium = percentAboveRrp(offer.pricePence, product?.officialRrpPence);
  if (Number.isFinite(find.maxPercentAboveRrp)) {
    if (!Number.isFinite(premium)) return { matched: false, reasons: ["rrp-unknown"] };
    if (premium > find.maxPercentAboveRrp) return { matched: false, reasons: ["rrp-premium-above-limit"] };
    reasons.push("rrp-premium");
  }

  if (find.scope === "local") return { matched: false, reasons: ["local-offer-location-unavailable"] };

  return { matched: true, reasons, deliveredPricePence: delivered, percentAboveRrp: premium };
}

function rowToFind(row) {
  return {
    id: row.id, userId: row.user_id, queryText: row.query_text || "", productIdentityId: row.product_identity_id,
    maxItemPricePence: row.max_item_price_pence == null ? null : Number(row.max_item_price_pence),
    maxTruePricePence: row.max_true_price_pence == null ? null : Number(row.max_true_price_pence),
    maxPercentAboveRrp: row.max_percent_above_rrp == null ? null : Number(row.max_percent_above_rrp),
    scope: row.scope || "either", preferredRetailerIds: row.preferred_retailers_json || [], excludedRetailerIds: row.excluded_retailers_json || [],
    stockRequirement: row.stock_requirement || "in_stock", notifications: row.notification_preferences_json || {},
  };
}

function rowToOffer(row) {
  return { offerId: row.offer_id, productId: row.product_id, retailerId: row.retailer_id, retailerName: row.retailer_name, title: row.title, url: row.url, pricePence: row.price_pence == null ? null : Number(row.price_pence), postagePence: row.postage_pence == null ? null : Number(row.postage_pence), stockStatus: row.stock_status, lastSeenAt: Number(row.last_seen_at) };
}

function rowToProduct(row) {
  return { id: row.id, title: row.title, officialRrpPence: row.official_rrp_pence == null ? null : Number(row.official_rrp_pence) };
}

function stableId(prefix, value) { return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`; }

export async function evaluateHostedFateFinds(pool, { limit = 2000, now = Math.floor(Date.now() / 1000) } = {}) {
  const { rows: findRows } = await pool.query(`
    SELECT f.* FROM fatedrop_fate_matches f
    JOIN fatedrop_memberships m ON m.user_id=f.user_id
    WHERE f.enabled=true AND m.tier IN ('plus','pro') AND m.status IN ('active','trialing')
    ORDER BY f.updated_at DESC LIMIT $1
  `, [limit]);
  if (!findRows.length) return { finds: 0, evaluated: 0, created: 0 };

  const { rows: offerRows } = await pool.query("SELECT * FROM fatedrop_retail_offers WHERE stock_status IN ('in_stock','low_stock','preorder') ORDER BY last_seen_at DESC LIMIT 10000");
  const productIds = [...new Set(offerRows.map((row) => row.product_id))];
  const { rows: productRows } = productIds.length ? await pool.query("SELECT * FROM fatedrop_products WHERE id = ANY($1)", [productIds]) : { rows: [] };
  const products = new Map(productRows.map((row) => [row.id, rowToProduct(row)]));
  let evaluated = 0, created = 0;

  for (const findRow of findRows) {
    const find = rowToFind(findRow);
    for (const rawOffer of offerRows) {
      const offer = rowToOffer(rawOffer); const product = products.get(offer.productId);
      evaluated += 1;
      const result = evaluateFateFind(find, offer, product);
      if (!result.matched) continue;
      const fingerprint = `${find.id}:${offer.offerId}:${offer.pricePence ?? "x"}:${offer.postagePence ?? "x"}:${offer.stockStatus}`;
      const id = stableId("fm", fingerprint);
      const response = await pool.query(`
        INSERT INTO fatedrop_hosted_fate_matches (id,fingerprint,fate_find_id,user_id,signal_offer_id,signal_product_id,retailer_id,retailer_name,title,url,item_price_pence,postage_pence,delivered_price_pence,rrp_pence,percent_above_rrp,stock_status,reasons_json,matched_at,last_observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
        ON CONFLICT (fingerprint) DO UPDATE SET last_observed_at=EXCLUDED.last_observed_at
        RETURNING (xmax = 0) AS inserted
      `, [id,fingerprint,find.id,find.userId,offer.offerId,offer.productId,offer.retailerId,offer.retailerName,title,offer.url,offer.pricePence,offer.postagePence,result.deliveredPricePence,product?.officialRrpPence ?? null,result.percentAboveRrp,offer.stockStatus,JSON.stringify(result.reasons),now,offer.lastSeenAt || now]);
      if (response.rows[0]?.inserted) {
        created += 1;
        await enqueueFateMatchNotifications(pool, { id, find, offer, product, result, now });
      }
    }
  }
  return { finds: findRows.length, evaluated, created };
}

async function enqueueFateMatchNotifications(pool, { id, find, offer, product, result, now }) {
  const prefsResult = await pool.query("SELECT * FROM fatedrop_notification_preferences WHERE user_id=$1", [find.userId]).catch(() => ({ rows: [] }));
  const prefs = prefsResult.rows[0] || {};
  const plan = notificationDeliveryPlan(prefs, find.notifications, now);
  const delivered = Number.isFinite(result.deliveredPricePence) ? `£${(result.deliveredPricePence / 100).toFixed(2)} delivered` : Number.isFinite(offer.pricePence) ? `£${(offer.pricePence / 100).toFixed(2)} + delivery unknown` : "price unavailable";
  const title = `FateMatch · ${product?.title || offer.title}`;
  const body = `${offer.retailerName} matched your FateFind at ${delivered}.`;
  for (const channel of ["web", "push", "discord"]) {
    const state = plan.enabled[channel] ? "pending" : "suppressed";
    const nextAttemptAt = plan.nextAttemptAt[channel];
    await pool.query(`INSERT INTO fatedrop_notification_outbox (id,dedupe_key,user_id,event_type,event_id,channel,title,body,url,payload_json,state,attempts,next_attempt_at,created_at,updated_at) VALUES ($1,$2,$3,'fate_match',$4,$5,$6,$7,$8,$9::jsonb,$10,0,$11,$12,$12) ON CONFLICT (dedupe_key) DO NOTHING`, [stableId("out",`${id}:${channel}`),`${id}:${channel}`,find.userId,id,channel,title,body,offer.url,JSON.stringify({ fateMatchId:id,fateFindId:find.id,offerId:offer.offerId,productId:offer.productId,retailerId:offer.retailerId,deliveredPricePence:result.deliveredPricePence,quietUntil:plan.quietUntil }),state,nextAttemptAt,now]);
  }
}
