import crypto from "node:crypto";
import { PriceQuality, classifyObservedPrice } from "../core/price-quality.mjs";
import { canEmitTcgLifecycleAlerts } from "../trader/tcg-registry.mjs";

export const HOSTED_OFFER_FRESHNESS_SECONDS = 1800;
export const HOSTED_MIN_STOCK_CONFIDENCE = 0.9;

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

function deliveredPence(offer) {
  const price = classifyObservedPrice({ pricePence: offer?.pricePence, retailerId: offer?.retailerId });
  if (!Number.isFinite(price.canonicalPricePence) || !Number.isFinite(offer?.postagePence)) return null;
  return price.canonicalPricePence + offer.postagePence;
}

function percentAboveRrp(pricePence, rrpPence) {
  if (!Number.isFinite(pricePence) || !Number.isFinite(rrpPence) || rrpPence <= 0) return null;
  return Math.round((((pricePence - rrpPence) / rrpPence) * 100) * 10) / 10;
}

function purchasable(status) {
  return status === "in_stock" || status === "low_stock" || status === "preorder";
}

export function offerObservationTrust(offer, {
  now = Math.floor(Date.now() / 1000),
  maxAgeSeconds = HOSTED_OFFER_FRESHNESS_SECONDS,
  minStockConfidence = HOSTED_MIN_STOCK_CONFIDENCE,
} = {}) {
  const observedAt = Number(offer?.lastSeenAt);
  if (!Number.isFinite(observedAt) || observedAt <= 0) {
    return { eligible: false, reason: "observation-time-unknown", ageSeconds: null, stockConfidence: null };
  }
  const rawAge = Number(now) - observedAt;
  if (!Number.isFinite(rawAge) || rawAge < -300) {
    return { eligible: false, reason: "observation-time-invalid", ageSeconds: rawAge, stockConfidence: null };
  }
  const ageSeconds = Math.max(0, rawAge);
  if (ageSeconds > maxAgeSeconds) {
    return { eligible: false, reason: "observation-stale", ageSeconds, stockConfidence: Number.isFinite(offer?.stockConfidence) ? offer.stockConfidence : null };
  }
  const stockConfidence = Number.isFinite(offer?.stockConfidence) ? Number(offer.stockConfidence) : null;
  if (stockConfidence !== null && stockConfidence < minStockConfidence) {
    return { eligible: false, reason: "stock-confidence-low", ageSeconds, stockConfidence };
  }
  return { eligible: true, reason: "fresh-trusted-observation", ageSeconds, stockConfidence };
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

export function evaluateFateFind(find, offer, product) {
  const reasons = [];
  const findTcgCode = String(find?.tcgCode || "pokemon").trim().toLowerCase();
  const productTcgCode = String(product?.tcgCode || "").trim().toLowerCase();
  if (!canEmitTcgLifecycleAlerts(findTcgCode)) return { matched: false, reasons: ["tcg-monitoring-inactive"] };
  if (!productTcgCode) return { matched: false, reasons: ["product-tcg-unknown"] };
  if (findTcgCode !== productTcgCode) return { matched: false, reasons: ["tcg-mismatch"] };
  const title = product?.title || offer.title || "";
  if (find.productIdentityId && find.productIdentityId === product?.id) reasons.push("product-identity");
  else if (!queryMatches(find.queryText, title)) return { matched: false, reasons: ["query-mismatch"] };
  else reasons.push("query");

  if (find.preferredRetailerIds.length && !find.preferredRetailerIds.includes(offer.retailerId)) return { matched: false, reasons: ["retailer-not-preferred"] };
  if (find.excludedRetailerIds.includes(offer.retailerId)) return { matched: false, reasons: ["retailer-excluded"] };

  if (find.stockRequirement === "in_stock" && !["in_stock", "low_stock"].includes(offer.stockStatus)) return { matched: false, reasons: ["stock-not-in-stock"] };
  if (find.stockRequirement === "purchasable" && !purchasable(offer.stockStatus)) return { matched: false, reasons: ["stock-not-purchasable"] };
  reasons.push(`stock:${offer.stockStatus}`);

  const price = classifyObservedPrice({ pricePence: offer.pricePence, retailerId: offer.retailerId });
  if ([PriceQuality.PLACEHOLDER, PriceQuality.INVALID].includes(price.priceQuality)) {
    return { matched: false, reasons: ["price-not-commercial"], priceQuality: price.priceQuality };
  }
  const commercialItemPricePence = price.canonicalPricePence;

  if (Number.isFinite(find.maxItemPricePence)) {
    if (!Number.isFinite(commercialItemPricePence) || commercialItemPricePence > find.maxItemPricePence) return { matched: false, reasons: ["item-price-above-limit"] };
    reasons.push("item-price");
  }

  const delivered = deliveredPence(offer);
  if (Number.isFinite(find.maxTruePricePence)) {
    if (!Number.isFinite(delivered)) return { matched: false, reasons: ["delivery-unknown"] };
    if (delivered > find.maxTruePricePence) return { matched: false, reasons: ["true-price-above-limit"] };
    reasons.push("true-price");
  }

  const premium = percentAboveRrp(commercialItemPricePence, product?.officialRrpPence);
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
    id: row.id, userId: row.user_id, tcgCode: row.tcg_code || "pokemon", queryText: row.query_text || "", productIdentityId: row.product_identity_id,
    maxItemPricePence: row.max_item_price_pence == null ? null : Number(row.max_item_price_pence),
    maxTruePricePence: row.max_true_price_pence == null ? null : Number(row.max_true_price_pence),
    maxPercentAboveRrp: row.max_percent_above_rrp == null ? null : Number(row.max_percent_above_rrp),
    scope: row.scope || "either", preferredRetailerIds: row.preferred_retailers_json || [], excludedRetailerIds: row.excluded_retailers_json || [],
    stockRequirement: row.stock_requirement || "in_stock", notifications: row.notification_preferences_json || {},
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
    stockConfidence: row.stock_confidence == null ? null : Number(row.stock_confidence),
    lastSeenAt: Number(row.last_seen_at),
  };
}

function rowToProduct(row) {
  return { id: row.id, tcgCode: row.tcg || null, title: row.title, officialRrpPence: row.official_rrp_pence == null ? null : Number(row.official_rrp_pence) };
}

function selectedTcgCodes(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return new Set(); }
  }
  return new Set(Array.isArray(parsed) ? parsed.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : []);
}

function stableId(prefix, value) { return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`; }

export async function evaluateHostedFateFinds(pool, { limit = 2000, now = Math.floor(Date.now() / 1000), fateFindId = null } = {}) {
  const requestedFateFindId = typeof fateFindId === "string" ? fateFindId.trim() : "";
  const findQuery = requestedFateFindId
    ? {
        sql: `
          SELECT f.* FROM fatedrop_fate_matches f
          JOIN fatedrop_memberships m ON m.user_id=f.user_id
          WHERE f.id=$1 AND f.enabled=true AND m.tier IN ('plus','pro') AND m.status IN ('active','trialing')
          LIMIT 1
        `,
        params: [requestedFateFindId],
      }
    : {
        sql: `
          SELECT f.* FROM fatedrop_fate_matches f
          JOIN fatedrop_memberships m ON m.user_id=f.user_id
          WHERE f.enabled=true AND m.tier IN ('plus','pro') AND m.status IN ('active','trialing')
          ORDER BY f.updated_at DESC LIMIT $1
        `,
        params: [limit],
      };
  const { rows: findRows } = await pool.query(findQuery.sql, findQuery.params);
  if (!findRows.length) return { finds: 0, evaluated: 0, created: 0 };

  const { rows: offerRows } = await pool.query(`
    SELECT ro.*
    FROM fatedrop_retail_offers ro
    JOIN fatedrop_retailer_health rh ON rh.retailer_id=ro.retailer_id
      AND rh.healthy=true
      AND COALESCE(rh.last_success_at,rh.last_scan_at) >= EXTRACT(EPOCH FROM NOW())::bigint - ${HOSTED_OFFER_FRESHNESS_SECONDS}
    WHERE ro.stock_status IN ('in_stock','low_stock','preorder')
      AND ro.last_seen_at >= EXTRACT(EPOCH FROM NOW())::bigint - ${HOSTED_OFFER_FRESHNESS_SECONDS}
      AND (ro.stock_confidence IS NULL OR ro.stock_confidence >= ${HOSTED_MIN_STOCK_CONFIDENCE})
    ORDER BY ro.last_seen_at DESC
    LIMIT 10000
  `);
  const productIds = [...new Set(offerRows.map((row) => row.product_id))];
  const { rows: productRows } = productIds.length ? await pool.query("SELECT * FROM fatedrop_products WHERE id = ANY($1)", [productIds]) : { rows: [] };
  const products = new Map(productRows.map((row) => [row.id, rowToProduct(row)]));
  let evaluated = 0, created = 0;

  for (const findRow of findRows) {
    const find = rowToFind(findRow);
    if (!canEmitTcgLifecycleAlerts(find.tcgCode)) continue;
    for (const rawOffer of offerRows) {
      const offer = rowToOffer(rawOffer);
      const trust = offerObservationTrust(offer, { now });
      if (!trust.eligible) continue;
      const product = products.get(offer.productId);
      const title = product?.title || offer.title || "Matched product";
      evaluated += 1;
      const result = evaluateFateFind(find, offer, product);
      if (!result.matched) continue;
      const fingerprint = `${find.tcgCode}:${find.id}:${offer.offerId}:${offer.pricePence ?? "x"}:${offer.postagePence ?? "x"}:${offer.stockStatus}`;
      const id = stableId("fm", fingerprint);
      const response = await pool.query(`
        INSERT INTO fatedrop_hosted_fate_matches (id,fingerprint,fate_find_id,user_id,tcg_code,signal_offer_id,signal_product_id,retailer_id,retailer_name,title,url,item_price_pence,postage_pence,delivered_price_pence,rrp_pence,percent_above_rrp,stock_status,reasons_json,matched_at,last_observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)
        ON CONFLICT (fingerprint) DO UPDATE SET last_observed_at=EXCLUDED.last_observed_at
        RETURNING (xmax = 0) AS inserted
      `, [id,fingerprint,find.id,find.userId,find.tcgCode,offer.offerId,offer.productId,offer.retailerId,offer.retailerName,title,offer.url,offer.pricePence,offer.postagePence,result.deliveredPricePence,product?.officialRrpPence ?? null,result.percentAboveRrp,offer.stockStatus,JSON.stringify(result.reasons),now,offer.lastSeenAt || now]);
      if (response.rows[0]?.inserted) {
        created += 1;
        await enqueueFateMatchNotifications(pool, { id, find, offer, product, result, now });
      }
    }
  }
  return { finds: findRows.length, evaluated, created };
}

async function enqueueFateMatchNotifications(pool, { id, find, offer, product, result, now }) {
  const prefsResult = await pool.query(`
    SELECT np.*,COALESCE(to_jsonb(u)->'selected_tcg_codes','["pokemon"]'::jsonb) AS selected_tcg_codes
    FROM fatedrop_users u
    LEFT JOIN fatedrop_notification_preferences np ON np.user_id=u.id
    WHERE u.id=$1
    LIMIT 1`, [find.userId]).catch(() => ({ rows: [] }));
  const prefs = prefsResult.rows[0] || {};
  const plan = notificationDeliveryPlan(prefs, find.notifications, now);
  const tcgSubscribed = selectedTcgCodes(prefs.selected_tcg_codes).has(find.tcgCode);
  const notification = buildFateMatchNotification({ find, offer, product, result });
  for (const channel of ["web", "push", "discord"]) {
    const state = tcgSubscribed && plan.enabled[channel] ? "pending" : "suppressed";
    const nextAttemptAt = plan.nextAttemptAt[channel];
    const payload = {
      fateMatchId: id,
      fateFindId: find.id,
      offerId: offer.offerId,
      productId: offer.productId,
      tcgCode: find.tcgCode,
      retailerId: offer.retailerId,
      quietUntil: plan.quietUntil,
      ...notification.payload,
    };
    await pool.query(`INSERT INTO fatedrop_notification_outbox (id,dedupe_key,user_id,event_type,event_id,channel,title,body,url,payload_json,state,attempts,next_attempt_at,created_at,updated_at) VALUES ($1,$2,$3,'fate_match',$4,$5,$6,$7,$8,$9::jsonb,$10,0,$11,$12,$12) ON CONFLICT (dedupe_key) DO NOTHING`, [stableId("out",`${id}:${channel}`),`${id}:${channel}`,find.userId,id,channel,notification.title,notification.body,offer.url,JSON.stringify(payload),state,nextAttemptAt,now]);
  }
}
