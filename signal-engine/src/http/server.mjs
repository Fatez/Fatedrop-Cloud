import http from "node:http";
import { env } from "../config/env.mjs";
import { retailers } from "../config/retailers.mjs";
import { ingestRetailerProducts, scanAll } from "../core/engine.mjs";
import { publishWebsiteSnapshot } from "../notifications/website.mjs";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}
function unauthorized(res) { json(res, 401, { error: "Unauthorized" }); }
function tokenFrom(req) { const auth=req.headers.authorization||""; return auth.startsWith("Bearer ") ? auth.slice(7) : ""; }
function parseCsv(value) { return value ? value.split(",").map((x)=>x.trim()).filter(Boolean) : []; }
async function readBody(req) { let raw=""; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error("Body too large"); } return raw ? JSON.parse(raw) : {}; }
function pounds(pence) { return Number.isFinite(pence) ? pence / 100 : undefined; }
function iso(epochSeconds) { return epochSeconds ? new Date(epochSeconds * 1000).toISOString() : undefined; }
function categoryOf(title="", productType="") {
  const source=`${productType} ${title}`;
  if (/graded|psa|cgc|bgs\s*\d/i.test(source)) return "GRADED";
  if (/#\d+|single|near mint|lightly played/i.test(source)) return "SINGLE";
  if (/sleeve|binder|deck box|playmat|accessor/i.test(source)) return "ACCESSORY";
  if (/pre[ -]?order/i.test(source)) return "PREORDER";
  if (/booster|elite trainer|collection|tin|box|pack|bundle|deck|sealed/i.test(source)) return "SEALED";
  return "OTHER";
}
function legacyAvailability(status) {
  if (["in_stock","low_stock"].includes(status)) return "IN_STOCK";
  if (status === "preorder") return "PREORDER";
  if (status === "out_of_stock") return "OUT_OF_STOCK";
  return "UNKNOWN";
}
function legacyOffer(offer, product) {
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
    rrpGbp: pounds(product?.officialRrpPence),
    rrpSource: product?.rrpSource || undefined,
    rrpObservedAt: iso(product?.rrpObservedAt),
    lastSeen: iso(offer.lastSeenAt),
  };
}
function titleKey(value="") { return value.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function optionalNumber(searchParams, name) {
  const raw=searchParams.get(name);
  if (raw===null || raw.trim()==="") return undefined;
  const value=Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

async function appCatalogue(store, url) {
  const [offers, products] = await Promise.all([store.listOffers({ limit: 10000 }), store.listProducts({ limit: 5000 })]);
  const productsById = new Map(products.map((product)=>[product.id,product]));
  const q=(url.searchParams.get("q")||"").trim().toLowerCase();
  const retailer=url.searchParams.get("retailer")||"";
  const excluded=new Set(parseCsv(url.searchParams.get("excludeRetailers")));
  const inStock=url.searchParams.get("inStock")==="true";
  const category=(url.searchParams.get("category")||"").toUpperCase();
  const minPrice=optionalNumber(url.searchParams,"minPrice");
  const maxPrice=optionalNumber(url.searchParams,"maxPrice");
  const sort=url.searchParams.get("sort")||"";
  const limit=Math.max(1,Math.min(100,Number.parseInt(url.searchParams.get("limit")||"50",10)||50));
  const offset=Math.max(0,Number.parseInt(url.searchParams.get("cursor")||"0",10)||0);
  let rows=offers.map((offer)=>legacyOffer(offer,productsById.get(offer.productId))).filter((offer)=>{
    if (q && !`${offer.title} ${offer.sku}`.toLowerCase().includes(q)) return false;
    if (retailer && offer.retailerKey!==retailer) return false;
    if (excluded.has(offer.retailerKey)) return false;
    if (inStock && offer.availability!=="IN_STOCK") return false;
    if (category && offer.category!==category) return false;
    if (minPrice!==undefined && (offer.price??Infinity)<minPrice) return false;
    if (maxPrice!==undefined && (offer.price??Infinity)>maxPrice) return false;
    return true;
  });
  if (sort==="price") rows.sort((a,b)=>(a.price??Infinity)-(b.price??Infinity));
  else if (sort==="title") rows.sort((a,b)=>a.title.localeCompare(b.title));
  else rows.sort((a,b)=>String(b.lastSeen||"").localeCompare(String(a.lastSeen||"")));
  const total=rows.length, page=rows.slice(offset,offset+limit), next=offset+limit<total?String(offset+limit):null;
  return { success:true,total,count:page.length,products:page,nextCursor:next,updatedAt:new Date().toISOString() };
}

async function appTruePrice(store, url) {
  const q=(url.searchParams.get("q")||"").trim().toLowerCase();
  if (q.length<2) return { success:true,count:0,groups:[],disclaimer:"Prices and stock can change on the retailer site. Delivery totals are only compared when delivery is known. RRP is only shown when FateDrop has an observed source for that product identity." };
  const [offers, products] = await Promise.all([store.listOffers({ limit:10000 }),store.listProducts({ limit:5000 })]);
  const productsById=new Map(products.map((product)=>[product.id,product])), grouped=new Map();
  for (const offer of offers) {
    if (!["in_stock","low_stock","preorder"].includes(offer.stockStatus)) continue;
    if (!offer.title.toLowerCase().includes(q)) continue;
    const product=productsById.get(offer.productId), key=offer.productId||titleKey(offer.title);
    const group=grouped.get(key)||{
      id:key,
      title:product?.title||offer.title,
      category:categoryOf(offer.title,product?.productType),
      matchingConfidence:offer.productId?1:0.75,
      retailerCount:0,
      rrpGbp:pounds(product?.officialRrpPence),
      rrpSource:product?.rrpSource||undefined,
      rrpObservedAt:iso(product?.rrpObservedAt),
      offers:[]
    };
    const deliveryKnown=Number.isFinite(offer.postagePence), totalPence=deliveryKnown&&Number.isFinite(offer.pricePence)?offer.pricePence+offer.postagePence:undefined;
    group.offers.push({ id:offer.offerId,retailerId:offer.retailerId,retailerName:offer.retailerName,title:offer.title,priceGbp:pounds(offer.pricePence),shippingGbp:pounds(offer.postagePence),totalDeliveredGbp:pounds(totalPence),deliveryKnown,collectionAvailable:false,productUrl:offer.url,imageUrl:offer.imageUrl,lastCheckedAt:iso(offer.lastSeenAt),stockStatus:legacyAvailability(offer.stockStatus),isLowestKnownDelivered:false });
    grouped.set(key,group);
  }
  const groups=[...grouped.values()].map((group)=>{
    group.retailerCount=new Set(group.offers.map((offer)=>offer.retailerId)).size;
    const known=group.offers.filter((offer)=>offer.deliveryKnown&&Number.isFinite(offer.totalDeliveredGbp));
    const lowest=known.length?Math.min(...known.map((offer)=>offer.totalDeliveredGbp)):undefined;
    group.offers=group.offers.map((offer)=>({...offer,isLowestKnownDelivered:lowest!==undefined&&offer.totalDeliveredGbp===lowest}));
    return group;
  }).sort((a,b)=>b.retailerCount-a.retailerCount||a.title.localeCompare(b.title));
  return { success:true,count:groups.length,groups,disclaimer:"Prices and stock can change on the retailer site. Delivery totals are only compared when delivery is known. RRP is only shown when FateDrop has an observed source for that product identity." };
}

export function createHttpServer({ store }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "OPTIONS") { res.writeHead(204,{"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"content-type,authorization,x-fatedrop-secret"}); return res.end(); }
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "fatedrop-signal-engine", version: "0.2.0" });
      if (req.method === "GET" && url.pathname === "/api/status") {
        const [stats, retailerHealth] = await Promise.all([store.stats(),store.listRetailers()]);
        return json(res,200,{success:true,monitor:{baselineComplete:retailerHealth.some((item)=>item.baselineCompleted),productsTracked:stats.productsTracked,offersTracked:stats.offersTracked,currentlyAvailable:stats.currentlyAvailable,retailers:retailerHealth.length},state:{retailers:retailerHealth}});
      }
      if (req.method === "GET" && url.pathname === "/api/catalogue") return json(res,200,await appCatalogue(store,url));
      if (req.method === "GET" && url.pathname === "/api/true-price") return json(res,200,await appTruePrice(store,url));
      if (req.method === "GET" && url.pathname === "/v1/network") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        return json(res, 200, { generatedAt: Math.floor(Date.now()/1000), stats: await store.stats(), retailers: await store.listRetailers() });
      }
      if (req.method === "GET" && url.pathname === "/v1/retailers") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        return json(res, 200, { retailers: await store.listRetailers() });
      }
      if (req.method === "GET" && url.pathname === "/v1/network/history") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        const limit = Math.max(1, Math.min(180, Number.parseInt(url.searchParams.get("limit") || "30", 10)));
        return json(res, 200, { snapshots: await store.listNetworkSnapshots(limit) });
      }
      if (req.method === "GET" && url.pathname === "/v1/signals") {
        if (env.apiToken && tokenFrom(req) !== env.apiToken) return unauthorized(res);
        const limit = Math.max(1, Math.min(250, Number.parseInt(url.searchParams.get("limit") || "100", 10)));
        const since = Math.max(0, Number.parseInt(url.searchParams.get("since") || "0", 10));
        const signals = await store.listSignals({ states: parseCsv(url.searchParams.get("state")), retailerIds: parseCsv(url.searchParams.get("retailer")), since, limit });
        return json(res, 200, { generatedAt: Math.floor(Date.now()/1000), signals });
      }
      if (req.method === "POST" && url.pathname === "/internal/scan") {
        if (!env.ingestSecret || req.headers["x-fatedrop-secret"] !== env.ingestSecret) return unauthorized(res);
        const body = await readBody(req);
        const selected = body.retailerIds?.length ? retailers.filter((r)=>body.retailerIds.includes(r.id)) : retailers;
        const results = await scanAll({ retailers: selected, store });
        const website = await publishWebsiteSnapshot({ store });
        return json(res, 200, { results, website });
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
    } catch (error) { return json(res, 500, { error: "Signal engine error", detail: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined }); }
  });
}
