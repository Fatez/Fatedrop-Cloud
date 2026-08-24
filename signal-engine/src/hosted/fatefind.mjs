import crypto from "node:crypto";
import { calculateOfferIntelligence } from "../core/price-intelligence.mjs";
import { buildRrpValueContext, resolveRrpValue } from "../core/rrp-value-reference.mjs";

function normalized(value = "") {
  return String(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedSearch(value = "") {
  return normalized(value)
    .replace(/\belite trainer boxes\b/g, "elite trainer box")
    .replace(/\betbs\b/g, "elite trainer box")
    .replace(/\betb\b/g, "elite trainer box")
    .replace(/\s+/g, " ")
    .trim();
}

function queryMatches(query, title) {
  const wanted = normalizedSearch(query).split(" ").filter(Boolean);
  const haystack = normalizedSearch(title);
  return wanted.length > 0 && wanted.every((token) => haystack.includes(token));
}

function roundedPercent(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
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

function money(pence) {
  if (!Number.isFinite(pence)) return null;
  return `£${(pence / 100).toFixed(2)}`;
}

export function buildFateMatchNotification({ find, offer, product, result }) {
  const productTitle = product?.title || offer.title || "Your hunted product";
  const delivered = money(result?.deliveredPricePence);
  const itemPrice = money(offer?.pricePence);
  const priceLabel = delivered ? `${delivered} delivered` : itemPrice ? `${itemPrice} + delivery unknown` : "price unavailable";
  const isPreorder = offer?.stockStatus === "preorder";
  const huntLabel = String(find?.queryText || productTitle).trim();

  return {
    title: isPreorder ? "Koru found it · your FateFind matched" : "Koru found stock · go get it",
    body: `${productTitle} matched your FateFind “${huntLabel}” at ${offer.retailerName} · ${priceLabel}. ${isPreorder ? "Open the listing now to check preorder terms." : "Move quickly — availability can change fast."}`,
    payload: {
      urgency: "high",
      companion: "Koru",
      huntQuery: huntLabel,
      stockStatus: offer?.stockStatus || null,
      deliveredPricePence: Number.isFinite(result?.deliveredPricePence) ? result.deliveredPricePence : null,
      rrpPence: Number.isFinite(result?.rrpPence) ? result.rrpPence : null,
      percentAboveRrp: Number.isFinite(result?.percentAboveRrp) ? result.percentAboveRrp : null,
      rrpKind: result?.rrpKind || null,
      rrpSource: result?.rrpSource || null,
    },
  };
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

export function evaluateFateFind(find, offer, product, rrpContext = null) {
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

  const context = rrpContext || buildRrpValueContext(product ? [product] : []);
  const rrpReference = resolveRrpValue({
    title,
    productType: product?.productType || offer.productType || "other",
    tcg: product?.tcg || offer.tcg || "pokemon",
    linkedProduct: product || null,
  }, context);
  const intelligence = calculateOfferIntelligence({
    pricePence: offer.pricePence,
    postagePence: offer.postagePence,
    officialRrpPence: rrpReference.resolved ? rrpReference.rrpPence : null,
    rrpSource: rrpReference.resolved ? rrpReference.rrpSource : null,
    rrpObservedAt: rrpReference.resolved ? rrpReference.rrpObservedAt : null,
  });
  const delivered = intelligence.deliveredPence;

  if (Number.isFinite(find.maxTruePricePence)) {
    if (!Number.isFinite(delivered)) return { matched: false, reasons: ["delivery-unknown"] };
    if (delivered > find.maxTruePricePence) return { matched: false, reasons: ["true-price-above-limit"] };
    reasons.push("true-price");
  }

  const premium = roundedPercent(intelligence.itemVsRrp.deltaPercent);
  if (Number.isFinite(find.maxPercentAboveRrp)) {
    if (!Number.isFinite(premium)) return {
      matched: false,
      reasons: [rrpReference.reason === "rrp_not_applicable" ? "rrp-not-applicable" : "rrp-unknown"],
      rrpReason: rrpReference.reason || null,
      rrpApplicabilityReason: rrpReference.applicabilityReason || null,
    };
    if (premium > find.maxPercentAboveRrp) return { matched: false, reasons: ["rrp-premium-above-limit"] };
    reasons.push("rrp-premium");
  }

  if (find.scope === "local") return { matched: false, reasons: ["local-offer-location-unavailable"] };

  return {
    matched: true,
    reasons,
    deliveredPricePence: delivered,
    percentAboveRrp: premium,
    rrpResolved: rrpReference.resolved === true,
    rrpPence: rrpReference.resolved ? rrpReference.rrpPence : null,
    rrpKind: rrpReference.resolved ? rrpReference.kind : null,
    rrpSource: rrpReference.resolved ? rrpReference.rrpSource : null,
    rrpReferenceBasis: rrpReference.resolved ? rrpReference.referenceBasis : null,
    rrpReason: rrpReference.resolved ? null : rrpReference.reason || "verified_rrp_unavailable",
    rrpApplicabilityReason: rrpReference.resolved ? null : rrpReference.applicabilityReason || null,
  };
}

function stockRank(status) {
  if (status === "in_stock") return 0;
  if (status === "low_stock") return 1;
  if (status === "preorder") return 2;
  return 3;
}

function preferredRetailerRank(find, retailerId) {
  if (!Array.isArray(find?.preferredRetailerIds) || !find.preferredRetailerIds.length) return 0;
  const index = find.preferredRetailerIds.indexOf(retailerId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function rankFateFindOffers(find, offers = [], products = new Map(), rrpContext = null) {
  const productMap = products instanceof Map
    ? products
    : new Map((products || []).map((product) => [product.id, product]));
  const context = rrpContext || buildRrpValueContext([...productMap.values()]);
  const candidates = [];

  for (const offer of offers || []) {
    const product = productMap.get(offer.productId) || null;
    const result = evaluateFateFind(find, offer, product, context);
    if (!result.matched) continue;
    candidates.push({ offer, product, result });
  }

  candidates.sort((a, b) => {
    const aHasRrp = Number.isFinite(a.result.percentAboveRrp);
    const bHasRrp = Number.isFinite(b.result.percentAboveRrp);
    if (aHasRrp !== bHasRrp) return aHasRrp ? -1 : 1;
    if (aHasRrp && bHasRrp && a.result.percentAboveRrp !== b.result.percentAboveRrp) {
      return a.result.percentAboveRrp - b.result.percentAboveRrp;
    }

    const aHasTruePrice = Number.isFinite(a.result.deliveredPricePence);
    const bHasTruePrice = Number.isFinite(b.result.deliveredPricePence);
    if (aHasTruePrice !== bHasTruePrice) return aHasTruePrice ? -1 : 1;
    if (aHasTruePrice && bHasTruePrice && a.result.deliveredPricePence !== b.result.deliveredPricePence) {
      return a.result.deliveredPricePence - b.result.deliveredPricePence;
    }

    const aPrice = Number.isFinite(a.offer.pricePence) ? a.offer.pricePence : Number.MAX_SAFE_INTEGER;
    const bPrice = Number.isFinite(b.offer.pricePence) ? b.offer.pricePence : Number.MAX_SAFE_INTEGER;
    if (aPrice !== bPrice) return aPrice - bPrice;

    const stockDifference = stockRank(a.offer.stockStatus) - stockRank(b.offer.stockStatus);
    if (stockDifference !== 0) return stockDifference;

    const aSeen = Number.isFinite(a.offer.lastSeenAt) ? a.offer.lastSeenAt : 0;
    const bSeen = Number.isFinite(b.offer.lastSeenAt) ? b.offer.lastSeenAt : 0;
    if (aSeen !== bSeen) return bSeen - aSeen;

    const retailerDifference = preferredRetailerRank(find, a.offer.retailerId) - preferredRetailerRank(find, b.offer.retailerId);
    if (retailerDifference !== 0) return retailerDifference;

    return String(a.offer.retailerName || "").localeCompare(String(b.offer.retailerName || ""));
  });

  return candidates.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    rankingBasis: Number.isFinite(candidate.result.percentAboveRrp) ? "rrp_value" : "true_price_rrp_unavailable",
  }));
}

export function selectBestFateFindOffer(find, offers = [], products = new Map(), rrpContext = null) {
  return rankFateFindOffers(find, offers, products, rrpContext)[0] || null;
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
  return { offerId: row.offer_id, productId: row.product_id, retailerId: row.retailer_id, retailerName: row.retailer_name, title: row.title, productType: row.product_type || null, tcg: row.tcg || null, url: row.url, pricePence: row.price_pence == null ? null : Number(row.price_pence), postagePence: row.postage_pence == null ? null : Number(row.postage_pence), stockStatus: row.stock_status, lastSeenAt: Number(row.last_seen_at) };
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
  const { rows: productRows } = productIds.length ? await pool.query(
    "SELECT id,title,product_type,tcg,official_rrp_pence,rrp_source,rrp_observed_at FROM fatedrop_products WHERE id = ANY($1) OR (official_rrp_pence IS NOT NULL AND rrp_source IS NOT NULL)",
    [productIds],
  ) : { rows: [] };
  const normalizedProducts = productRows.map(rowToProduct);
  const products = new Map(normalizedProducts.map((product) => [product.id, product]));
  const rrpContext = buildRrpValueContext(normalizedProducts);
  let evaluated = 0, created = 0;

  for (const findRow of findRows) {
    const find = rowToFind(findRow);
    for (const rawOffer of offerRows) {
      const offer = rowToOffer(rawOffer); const product = products.get(offer.productId);
      evaluated += 1;
      const result = evaluateFateFind(find, offer, product, rrpContext);
      if (!result.matched) continue;
      const fingerprint = `${find.id}:${offer.offerId}:${offer.pricePence ?? "x"}:${offer.postagePence ?? "x"}:${offer.stockStatus}`;
      const id = stableId("fm", fingerprint);
      const response = await pool.query(`
        INSERT INTO fatedrop_hosted_fate_matches (id,fingerprint,fate_find_id,user_id,signal_offer_id,signal_product_id,retailer_id,retailer_name,title,url,item_price_pence,postage_pence,delivered_price_pence,rrp_pence,percent_above_rrp,stock_status,reasons_json,matched_at,last_observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
        ON CONFLICT (fingerprint) DO UPDATE SET last_observed_at=EXCLUDED.last_observed_at
        RETURNING (xmax = 0) AS inserted
      `, [id,fingerprint,find.id,find.userId,offer.offerId,offer.productId,offer.retailerId,offer.retailerName,product?.title || offer.title || "",offer.url,offer.pricePence,offer.postagePence,result.deliveredPricePence,result.rrpPence,result.percentAboveRrp,offer.stockStatus,JSON.stringify(result.reasons),now,offer.lastSeenAt || now]);
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
  const notification = buildFateMatchNotification({ find, offer, product, result });
  for (const channel of ["web", "push", "discord"]) {
    const state = plan.enabled[channel] ? "pending" : "suppressed";
    const nextAttemptAt = plan.nextAttemptAt[channel];
    const payload = {
      fateMatchId: id,
      fateFindId: find.id,
      offerId: offer.offerId,
      productId: offer.productId,
      retailerId: offer.retailerId,
      quietUntil: plan.quietUntil,
      ...notification.payload,
    };
    await pool.query(`INSERT INTO fatedrop_notification_outbox (id,dedupe_key,user_id,event_type,event_id,channel,title,body,url,payload_json,state,attempts,next_attempt_at,created_at,updated_at) VALUES ($1,$2,$3,'fate_match',$4,$5,$6,$7,$8,$9::jsonb,$10,0,$11,$12,$12) ON CONFLICT (dedupe_key) DO NOTHING`, [stableId("out",`${id}:${channel}`),`${id}:${channel}`,find.userId,id,channel,notification.title,notification.body,offer.url,JSON.stringify(payload),state,nextAttemptAt,now]);
  }
}
