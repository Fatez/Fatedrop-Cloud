import http from "node:http";
import { env } from "../config/env.mjs";
import { retailers } from "../config/retailers.mjs";
import { resolveRetailerDelivery } from "../core/delivery-policies.mjs";
import { ingestRetailerDiscoveryObservations } from "../core/discovery-intake.mjs";
import { ingestRetailerProducts, scanAll } from "../core/engine.mjs";
import { compareGroups, rankGroups } from "../core/fate-verdict.mjs";
import { recordRetailerReadiness } from "../core/network-readiness.mjs";
import { commercialPricePence } from "../core/price-quality.mjs";
import { buildRrpValueContext, resolveRrpValue } from "../core/rrp-value-reference.mjs";
import { publishWebsiteSnapshot } from "../notifications/website.mjs";
import { syncAsmodeeRrp } from "../rrp/asmodee-authority.mjs";

const PUBLIC_SIGNAL_STATES = ["whisper", "echo", "manifested", "vanished"];

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function unauthorized(res) { json(res, 401, { error: "Unauthorized" }); }
function tokenFrom(req) { const auth = req.headers.authorization || ""; return auth.startsWith("Bearer ") ? auth.slice(7) : ""; }
function authorizedApi(req) { return Boolean(env.apiToken) && tokenFrom(req) === env.apiToken; }
function parseCsv(value) { return value ? value.split(",").map((x) => x.trim()).filter(Boolean) : []; }
async function readBody(req) { let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error("Body too large"); } return raw ? JSON.parse(raw) : {}; }
function pounds(pence) { return Number.isFinite(pence) ? pence / 100 : undefined; }
function iso(epochSeconds) { return epochSeconds ? new Date(epochSeconds * 1000).toISOString() : undefined; }

function categoryOf(title = "", productType = "") {
  const source = `${productType} ${title}`;
  if (/graded|psa|cgc|bgs\s*\d/i.test(source)) return "GRADED";
  if (/#\d+|single|near mint|lightly played/i.test(source)) return "SINGLE";
  if (/sleeve|binder|deck box|playmat|accessor/i.test(source)) return "ACCESSORY";
  if (/pre[ -]?order/i.test(source)) return "PREORDER";
  if (/booster|elite trainer|collection|tin|box|pack|bundle|deck|sealed/i.test(source)) return "SEALED";
  return "OTHER";
}

function legacyAvailability(status) {
  if (["in_stock", "low_stock"].includes(status)) return "IN_STOCK";
  if (status === "preorder") return "PREORDER";
  if (status === "out_of_stock") return "OUT_OF_STOCK";
  return "UNKNOWN";
}

function rrpFields(rrp) {
  if (!rrp?.resolved) return {};
  return {
    rrpGbp: pounds(rrp.rrpPence),
    rrpSource: rrp.rrpSource || undefined,
    rrpKind: rrp.kind || "official",
    rrpObservedAt: iso(rrp.rrpObservedAt),
    rrpReferenceBasis: rrp.referenceBasis || undefined,
    unitCount: Number.isFinite(rrp.unitCount) ? rrp.unitCount : undefined,
    unitKind: rrp.unitKind || undefined,
    unitRrpGbp: pounds(rrp.unitRrpPence),
    referenceProductIds: Array.isArray(rrp.matchedProductIds) ? rrp.matchedProductIds : undefined,
  };
}

function valueFamilyKey(rrp) {
  if (!rrp?.resolved || !rrp.unitKind || !Array.isArray(rrp.matchedProductIds) || !rrp.matchedProductIds.length) return null;
  const ids = [...new Set(rrp.matchedProductIds.map((id) => String(id || "").trim()).filter(Boolean))].sort();
  return ids.length ? `rrp:${String(rrp.unitKind).toLowerCase()}:${ids.join("+")}` : null;
}

function productConfigurationGroup(product, rrp) {
  if (!product?.id) return null;
  return {
    id: product.id,
    canonicalProductId: product.id,
    configurationId: product.id,
    title: product.title || "Product configuration",
    category: categoryOf(product.title || "", product.productType),
    matchingConfidence: rrp?.resolved ? 1 : 0.75,
    retailerCount: 0,
    identityKey: product.canonicalKey || null,
    valueFamilyKey: valueFamilyKey(rrp),
    ...rrpFields(rrp),
    configuration: {
      unitCount: Number.isFinite(rrp?.unitCount) ? rrp.unitCount : null,
      unitKind: rrp?.unitKind || null,
      referenceKind: rrp?.kind || null,
    },
    offers: [],
  };
}

async function resolveSelectedConfigurationGroup(store, productId) {
  if (!productId) return null;
  const products = await store.listProducts({ limit: 5000 });
  const product = products.find((item) => item.id === productId);
  if (!product) return null;
  const rrpContext = buildRrpValueContext(products);
  const rrp = resolveRrpValue({
    title: product.title,
    productType: product.productType,
    tcg: product.tcg || "pokemon",
    linkedProduct: product,
  }, rrpContext);
  return productConfigurationGroup(product, rrp);
}

function legacyOffer(offer, product, rrp) {
  return {
    id: offer.offerId,
    sku: offer.retailerSku,
    retailerKey: offer.retailerId,
    retailer: offer.retailerName,
    title: offer.title,
    url: offer.url,
    image: offer.imageUrl,
    price: pounds(offer.pricePence),
    shippingGbp: pounds(offer.postagePence),
    availability: legacyAvailability(offer.stockStatus),
    isCurrentlyListed: offer.stockStatus !== "out_of_stock",
    category: categoryOf(offer.title, product?.productType),
    productId: offer.productId,
    ...rrpFields(rrp),
    lastSeen: iso(offer.lastSeenAt),
  };
}

function titleKey(value = "") { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

const SEARCH_ALIASES = new Map([
  ["etb", ["elite", "trainer", "box"]],
]);

const SEARCH_GENERIC_TOKENS = new Set(["pokemon", "tcg"]);

function searchTerms(value = "") {
  const raw = titleKey(value).split(" ").filter(Boolean);
  const expanded = raw.flatMap((token) => SEARCH_ALIASES.get(token) || [token]);
  const specific = expanded.filter((token) => !SEARCH_GENERIC_TOKENS.has(token));
  return specific.length ? [...new Set(specific)] : [...new Set(expanded)];
}

function searchMatchScore(query, offer) {
  const clean = titleKey(query);
  if (!clean) return 1;
  const title = titleKey(offer?.title || "");
  const sku = titleKey(offer?.sku || "");
  const haystack = `${title} ${sku}`.trim();
  const terms = searchTerms(clean);
  if (!terms.length) return 0;
  if (title === clean) return 1000;
  if (sku && sku === clean) return 950;
  if (title.startsWith(clean)) return 900;
  if (title.includes(clean)) return 800;
  if (!terms.every((term) => haystack.includes(term))) return 0;
  const titleHits = terms.filter((term) => title.includes(term)).length;
  return 600 + (titleHits * 10) - Math.max(0, title.split(" ").length - terms.length);
}
function optionalNumber(searchParams, name) { const raw = searchParams.get(name); if (raw === null || raw.trim() === "") return undefined; const value = Number(raw); return Number.isFinite(value) ? value : undefined; }

function resolveOfferRrp(offer, linkedProduct, rrpContext) {
  return resolveRrpValue({
    title: linkedProduct?.title || offer.title,
    productType: linkedProduct?.productType || offer.productType,
    tcg: linkedProduct?.tcg || "pokemon",
    linkedProduct,
  }, rrpContext);
}

function publicSignal(signal) {
  if (!signal || !PUBLIC_SIGNAL_STATES.includes(signal.state)) return null;
  return {
    id: signal.id,
    state: signal.state,
    productId: signal.productId || null,
    offerId: signal.offerId || null,
    retailerId: signal.retailerId || null,
    retailerName: signal.retailerName || null,
    title: signal.title || "Product activity",
    productType: signal.productType || null,
    productUrl: signal.url || signal.target?.productUrl || null,
    imageUrl: signal.imageUrl || null,
    priceGbp: pounds(signal.pricePence),
    rrpGbp: pounds(signal.rrpPence),
    markupPercent: Number.isFinite(signal.markupPercent) ? signal.markupPercent : undefined,
    stockStatus: signal.stockStatus || "unknown",
    confidence: Number.isFinite(signal.confidence) ? signal.confidence : undefined,
    detectedAt: iso(signal.detectedAt),
    reason: signal.reason || null,
    target: signal.target || {
      type: "product",
      productId: signal.productId || null,
      offerId: signal.offerId || null,
      retailerId: signal.retailerId || null,
      productUrl: signal.url || null,
      query: signal.title || "",
    },
  };
}

async function appCatalogue(store, url) {
  const [offers, products] = await Promise.all([store.listOffers({ limit: 10000 }), store.listProducts({ limit: 5000 })]);
  const productsById = new Map(products.map((p) => [p.id, p]));
  const rrpContext = buildRrpValueContext(products);
  const q = (url.searchParams.get("q") || "").trim();
  const retailer = url.searchParams.get("retailer") || "";
  const excluded = new Set(parseCsv(url.searchParams.get("excludeRetailers")));
  const inStock = url.searchParams.get("inStock") === "true";
  const category = (url.searchParams.get("category") || "").toUpperCase();
  const minPrice = optionalNumber(url.searchParams, "minPrice");
  const maxPrice = optionalNumber(url.searchParams, "maxPrice");
  const sort = url.searchParams.get("sort") || "";
  const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0);

  let rows = offers.map((offer) => {
    const linkedProduct = productsById.get(offer.productId);
    const rrp = resolveOfferRrp(offer, linkedProduct, rrpContext);
    const publicOffer = legacyOffer(offer, linkedProduct, rrp);
    return { ...publicOffer, _searchScore: searchMatchScore(q, publicOffer) };
  }).filter((offer) => {
    if (q && offer._searchScore <= 0) return false;
    if (retailer && offer.retailerKey !== retailer) return false;
    if (excluded.has(offer.retailerKey)) return false;
    if (inStock && offer.availability !== "IN_STOCK") return false;
    if (category && offer.category !== category) return false;
    if (minPrice !== undefined && (offer.price ?? Infinity) < minPrice) return false;
    if (maxPrice !== undefined && (offer.price ?? Infinity) > maxPrice) return false;
    return true;
  });

  if (sort === "price") rows.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  else if (sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === "recent") rows.sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
  else if (q || sort === "relevance") rows.sort((a, b) => b._searchScore - a._searchScore || String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
  else rows.sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));

  const total = rows.length;
  const page = rows.slice(offset, offset + limit).map(({ _searchScore, ...offer }) => offer);
  const next = offset + limit < total ? String(offset + limit) : null;
  return { success: true, total, count: page.length, products: page, nextCursor: next, updatedAt: new Date().toISOString() };
}

async function appTruePrice(store, url) {
  const q = (url.searchParams.get("q") || "").trim();
  const disclaimer = "Prices and stock can change on the retailer site. FateDrop shows verified official RRP where identity is exact, and clearly-labelled component references only when bundle quantity and a verified unit RRP are both provable. Delivery totals are only compared when delivery is known.";
  if (q.length < 2) return { success: true, count: 0, groups: [], disclaimer };

  const [offers, products] = await Promise.all([store.listOffers({ limit: 10000 }), store.listProducts({ limit: 5000 })]);
  const productsById = new Map(products.map((p) => [p.id, p]));
  const rrpContext = buildRrpValueContext(products);
  const grouped = new Map();

  for (const offer of offers) {
    if (!["in_stock", "low_stock", "preorder"].includes(offer.stockStatus)) continue;
    if (q && searchMatchScore(q, { title: offer.title, sku: offer.retailerSku }) <= 0) continue;

    // £0 / £0.01 and any other non-commercial observations remain available to
    // monitoring intelligence, but cannot enter True Price or Fate Verdict.
    const canonicalPricePence = commercialPricePence(offer.pricePence);
    if (!Number.isFinite(canonicalPricePence)) continue;

    const linkedProduct = productsById.get(offer.productId);
    const rrp = resolveOfferRrp(offer, linkedProduct, rrpContext);
    const exactCanonicalId = rrp.resolved && rrp.kind === "official" && rrp.matchedProductIds?.length === 1 ? rrp.matchedProductIds[0] : null;
    const canonicalProduct = exactCanonicalId ? productsById.get(exactCanonicalId) : linkedProduct;
    const key = exactCanonicalId || linkedProduct?.id || offer.productId || titleKey(offer.title);
    const group = grouped.get(key) || {
      id: key,
      canonicalProductId: key,
      configurationId: key,
      title: canonicalProduct?.title || offer.title,
      category: categoryOf(offer.title, canonicalProduct?.productType || linkedProduct?.productType),
      matchingConfidence: rrp.resolved ? 1 : (offer.productId ? 1 : 0.75),
      retailerCount: 0,
      identityKey: canonicalProduct?.canonicalKey || linkedProduct?.canonicalKey || null,
      valueFamilyKey: valueFamilyKey(rrp),
      ...rrpFields(rrp),
      configuration: {
        unitCount: Number.isFinite(rrp?.unitCount) ? rrp.unitCount : null,
        unitKind: rrp?.unitKind || null,
        referenceKind: rrp?.kind || null,
      },
      offers: [],
    };
    const resolved = resolveRetailerDelivery({ retailerId: offer.retailerId, subtotalPence: canonicalPricePence });
    const postage = Number.isFinite(offer.postagePence) ? offer.postagePence : resolved.postagePence;
    const deliveryKnown = Number.isFinite(postage);
    const totalPence = deliveryKnown ? canonicalPricePence + postage : undefined;
    group.offers.push({
      id: offer.offerId,
      retailerId: offer.retailerId,
      retailerName: offer.retailerName,
      title: offer.title,
      priceGbp: pounds(canonicalPricePence),
      shippingGbp: pounds(postage),
      totalDeliveredGbp: pounds(totalPence),
      deliveryKnown,
      freeShippingThresholdGbp: pounds(resolved.freeShippingThresholdPence),
      collectionAvailable: resolved.collectionAvailable === true,
      productUrl: offer.url,
      imageUrl: offer.imageUrl,
      lastCheckedAt: iso(offer.lastSeenAt),
      stockStatus: legacyAvailability(offer.stockStatus),
      isLowestKnownDelivered: false,
    });
    grouped.set(key, group);
  }

  const groups = [...grouped.values()].map((group) => {
    group.retailerCount = new Set(group.offers.map((offer) => offer.retailerId)).size;
    const known = group.offers.filter((offer) => offer.deliveryKnown && Number.isFinite(offer.totalDeliveredGbp));
    const lowest = known.length ? Math.min(...known.map((offer) => offer.totalDeliveredGbp)) : undefined;
    group.offers = group.offers.map((offer) => ({ ...offer, isLowestKnownDelivered: lowest !== undefined && offer.totalDeliveredGbp === lowest }));
    return group;
  }).sort((a, b) => b.retailerCount - a.retailerCount || a.title.localeCompare(b.title));

  return { success: true, count: groups.length, groups, disclaimer };
}

async function appFateVerdict(store, req, body) {
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  const truePriceUrl = new URL("/api/true-price", `http://${req.headers.host || "localhost"}`);
  truePriceUrl.searchParams.set("q", query);
  const truePrice = await appTruePrice(store, truePriceUrl);
  const leftId = typeof body?.leftId === "string" && body.leftId.trim() ? body.leftId.trim() : null;
  const rightId = typeof body?.rightId === "string" && body.rightId.trim() ? body.rightId.trim() : null;

  let leftGroup = leftId ? truePrice.groups.find((group) => group.id === leftId) || null : null;
  let rightGroup = rightId ? truePrice.groups.find((group) => group.id === rightId) || null : null;

  // A selected configuration can disappear from the live-offer group list between
  // the App loading the selector and the head-to-head request (for example, a scan
  // confirms it just sold out). Preserve the canonical configuration identity so
  // the authoritative reason becomes NO_QUALIFYING_LIVE_OFFERS, not a false
  // IDENTITY_UNRESOLVED. This does not make an out-of-stock offer eligible.
  if (leftId && !leftGroup) leftGroup = await resolveSelectedConfigurationGroup(store, leftId);
  if (rightId && !rightGroup) rightGroup = await resolveSelectedConfigurationGroup(store, rightId);

  const pairVerdict = leftId && rightId ? compareGroups(leftGroup, rightGroup) : null;

  return {
    success: true,
    mode: "verdict",
    count: truePrice.count,
    groups: truePrice.groups,
    verdict: rankGroups(truePrice.groups),
    pairVerdict,
    source: "FATEDROP_CLOUD",
    rulesVersion: "fate-verdict-v2",
    runtime: {
      gitCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    },
    disclaimer: "RRP/reference percentage uses commercial item price against the verified value baseline. True Price adds known mandatory delivery; unknown delivery remains unknown and never becomes £0.",
    notice: "Canonical FateDrop Cloud verdict is live.",
  };
}

export function createHttpServer({ store }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization,x-fatedrop-secret",
        });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "fatedrop-signal-engine", version: "0.2.0" });
      if (req.method === "GET" && url.pathname === "/api/status") {
        const [stats, retailerHealth] = await Promise.all([store.stats(), store.listRetailers()]);
        return json(res, 200, {
          success: true,
          monitor: {
            baselineComplete: retailerHealth.some((item) => item.baselineCompleted),
            productsTracked: stats.productsTracked,
            offersTracked: stats.offersTracked,
            currentlyAvailable: stats.currentlyAvailable,
            retailers: retailerHealth.length,
          },
          state: { retailers: retailerHealth },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/catalogue") return json(res, 200, await appCatalogue(store, url));
      if (req.method === "GET" && url.pathname === "/api/true-price") return json(res, 200, await appTruePrice(store, url));
      if (req.method === "POST" && url.pathname === "/api/fatefind/matches") {
        const body = await readBody(req);
        if (body?.mode !== "verdict") {
          return json(res, 400, {
            success: false,
            mode: "verdict",
            source: "FATEDROP_CLOUD",
            error: "INVALID_VERDICT_MODE",
            reason: "mode must be verdict",
          });
        }
        return json(res, 200, await appFateVerdict(store, req, body));
      }
      if (req.method === "GET" && url.pathname === "/api/signals") {
        const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
        const since = Math.max(0, Number.parseInt(url.searchParams.get("since") || "0", 10));
        const requested = parseCsv(url.searchParams.get("state")).map((v) => v.toLowerCase()).filter((v) => PUBLIC_SIGNAL_STATES.includes(v));
        const states = requested.length ? requested : PUBLIC_SIGNAL_STATES;
        const raw = await store.listSignals({ states, retailerIds: [], since, limit: Math.min(250, limit * 3) });
        const signals = raw.map(publicSignal).filter(Boolean).slice(0, limit);
        return json(res, 200, { success: true, count: signals.length, generatedAt: new Date().toISOString(), signals });
      }
      if (req.method === "GET" && url.pathname === "/v1/network") {
        if (!authorizedApi(req)) return unauthorized(res);
        return json(res, 200, { generatedAt: Math.floor(Date.now() / 1000), stats: await store.stats(), retailers: await store.listRetailers() });
      }
      if (req.method === "GET" && url.pathname === "/v1/retailers") {
        if (!authorizedApi(req)) return unauthorized(res);
        return json(res, 200, { retailers: await store.listRetailers() });
      }
      if (req.method === "GET" && url.pathname === "/v1/network/history") {
        if (!authorizedApi(req)) return unauthorized(res);
        const limit = Math.max(1, Math.min(180, Number.parseInt(url.searchParams.get("limit") || "30", 10)));
        return json(res, 200, { snapshots: await store.listNetworkSnapshots(limit) });
      }
      if (req.method === "GET" && url.pathname === "/v1/signals") {
        if (!authorizedApi(req)) return unauthorized(res);
        const limit = Math.max(1, Math.min(250, Number.parseInt(url.searchParams.get("limit") || "100", 10)));
        const since = Math.max(0, Number.parseInt(url.searchParams.get("since") || "0", 10));
        const signals = await store.listSignals({ states: parseCsv(url.searchParams.get("state")), retailerIds: parseCsv(url.searchParams.get("retailer")), since, limit });
        return json(res, 200, { generatedAt: Math.floor(Date.now() / 1000), signals });
      }
      if (req.method === "POST" && url.pathname === "/internal/network-state") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        const body = await readBody(req);
        const retailer = retailers.find((item) => item.id === body.retailerId);
        if (!retailer) return json(res, 400, { error: "Unknown or disabled retailer" });
        const result = await recordRetailerReadiness({
          retailer,
          store,
          state: String(body.state || ""),
          previousState: body.previousState ? String(body.previousState) : null,
          observedAt: Number.isFinite(body.observedAt) ? Math.trunc(body.observedAt) : Math.floor(Date.now() / 1000),
          evidence: Array.isArray(body.evidence) ? body.evidence : [],
        });
        return json(res, 200, { result });
      }
      if (req.method === "POST" && url.pathname === "/internal/rrp/asmodee-sync") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        if (!env.databaseUrl) return json(res, 503, { error: "DATABASE_URL is not configured" });
        const result = await syncAsmodeeRrp({ databaseUrl: env.databaseUrl });
        return json(res, 200, { success: true, result });
      }
      if (req.method === "POST" && url.pathname === "/internal/scan") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        const body = await readBody(req);
        const selected = body.retailerIds?.length ? retailers.filter((item) => body.retailerIds.includes(item.id)) : retailers;
        const results = await scanAll({ retailers: selected, store });
        const website = await publishWebsiteSnapshot({ store });
        return json(res, 200, { results, website });
      }
      if (req.method === "POST" && url.pathname === "/internal/discovery-observations") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        const body = await readBody(req);
        const retailer = retailers.find((item) => item.id === body.retailerId);
        if (!retailer) return json(res, 400, { error: "Unknown or disabled retailer" });
        const observations = Array.isArray(body.observations) ? body.observations : [];
        if (!observations.length) return json(res, 400, { error: "observations must be a non-empty array" });
        const result = await ingestRetailerDiscoveryObservations({ retailer, store, observations });
        const website = await publishWebsiteSnapshot({ store });
        return json(res, 200, { result, website });
      }
      if (req.method === "POST" && url.pathname === "/internal/ingest") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        const body = await readBody(req);
        const retailer = retailers.find((item) => item.id === body.retailerId);
        if (!retailer) return json(res, 400, { error: "Unknown or disabled retailer" });
        if (!Array.isArray(body.products) || body.products.length === 0) return json(res, 400, { error: "products must be a non-empty array" });
        const result = await ingestRetailerProducts({ retailer, store, products: body.products });
        const website = await publishWebsiteSnapshot({ store });
        return json(res, 200, { result, website });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      return json(res, 500, { error: "Signal engine error", detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined });
    }
  });
}
