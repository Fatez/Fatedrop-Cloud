import { env } from "../config/env.mjs";
import { buildLocalRadar, distanceMiles, normalizeEncounterBatch } from "../encounters/local-radar-contract.mjs";
import {
  normalizeLocalStockObservationBatch,
  normalizeRetailerLocationBatch,
  upsertLocalStockObservationsIntoStore,
  upsertRetailerLocationsIntoStore,
} from "../encounters/local-stock-store.mjs";
import { lookupUkPostcode, lookupUkPostcodes } from "../encounters/postcode.mjs";
import {
  listEncounterInventoryFromStore,
  listEncounterVendorsFromStore,
  listEncountersFromStore,
  upsertEncounterInventoryIntoStore,
  upsertEncounterVendorsIntoStore,
  upsertEncountersIntoStore,
} from "../encounters/store.mjs";
import { normalizeInventoryBatch, normalizeVendorBatch } from "../encounters/vendors.mjs";
import { createRateLimiter } from "../security/rate-limit.mjs";
import { createLiveOfferReadStore } from "../stores/live-offer-read-store.mjs";
import { handlePublicSignals, handlePublicSignalSummary } from "../telemetry/public-signal-contract.mjs";
import { handlePublicAlertFacets } from "../telemetry/public-alert-contract.mjs";
import { handleFateTraderCatalogue, isFateTraderCataloguePath } from "../trader/catalogue/http.mjs";
import { handleFateTraderCollection, isFateTraderCollectionPath } from "../trader/collection/http.mjs";
import { handleFateTraderBinder, isFateTraderBinderPath } from "../trader/binder/http.mjs";
import { handleFateTraderMatching, isFateTraderMatchingPath } from "../trader/matching/http.mjs";
import { handleFateTraderTrust, isFateTraderTrustPath } from "../trader/trust/http.mjs";
import { handleFateTraderSafeExchange, isFateTraderSafeExchangePath } from "../trader/safe-exchange/http.mjs";
import { createHttpServer as createLegacyHttpServer } from "./server.mjs";

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}
function rateLimited(res, decision) {
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": String(decision.retryAfterSeconds),
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-ratelimit-reset": String(Math.ceil(decision.resetAt / 1000)),
  });
  res.end(JSON.stringify({
    error: "Too many requests",
    code: "RATE_LIMITED",
    retryAfterSeconds: decision.retryAfterSeconds,
  }));
}
function parseCsv(value) { return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []; }
function optionalNumber(params, name) { const raw=params.get(name); if(raw==null||raw.trim()==="")return null; const parsed=Number(raw); return Number.isFinite(parsed)?parsed:null; }
async function readBody(req) { let raw=""; for await(const chunk of req){raw+=chunk;if(raw.length>2_000_000)throw new Error("Body too large");} return raw?JSON.parse(raw):{}; }
function eventFilters(url) { const from=url.searchParams.get("from")||new Date().toISOString(); const to=url.searchParams.get("to")||null; const tcgs=parseCsv(url.searchParams.get("tcg")).map((value)=>value.toLowerCase()); const limit=Math.max(1,Math.min(2000,Number.parseInt(url.searchParams.get("limit")||"1000",10)||1000)); return{from,to,tcgs,limit}; }
function authorized(req){return Boolean(env.ingestSecret)&&req.headers["x-fatedrop-secret"]===env.ingestSecret;}
function vendorEventId(pathname){const match=pathname.match(/^\/api\/encounters\/([^/]+)\/vendors$/);return match?decodeURIComponent(match[1]):null;}
function postcodeKey(value){return String(value||"").replace(/\s+/g,"").toUpperCase();}
function point(latitude,longitude){return Number.isFinite(latitude)&&Number.isFinite(longitude)?{latitude,longitude}:null;}

async function resolveRadarLocation(url, postcodeLookup) {
  const latitude=optionalNumber(url.searchParams,"lat");
  const longitude=optionalNumber(url.searchParams,"lng");
  const postcode=(url.searchParams.get("postcode")||"").trim()||null;
  const hasLat=url.searchParams.has("lat");
  const hasLng=url.searchParams.has("lng");
  if(hasLat!==hasLng){
    return {requested:true,origin:null,resolution:{status:"invalid",source:"device_coordinates",postcode:null,latitude:null,longitude:null,reason:"Both lat and lng are required"}};
  }
  if(latitude!=null&&longitude!=null){
    return {requested:true,origin:{latitude,longitude},resolution:{status:"ok",source:"device_coordinates",postcode:null,latitude,longitude}};
  }
  if(postcode){
    const resolution=await postcodeLookup({postcode});
    const origin=resolution?.status==="ok"?point(resolution.latitude,resolution.longitude):null;
    return {requested:true,origin,resolution};
  }
  return {requested:false,origin:null,resolution:{status:"not_requested",source:null,postcode:null,latitude:null,longitude:null}};
}

async function distanceSafeEvents(events,{origin,radiusMiles,postcodeBatchLookup}){
  if(!origin)return events;
  const needsPostcode=events.filter((event)=>!point(event.latitude,event.longitude)&&event.postcode).map((event)=>event.postcode);
  const postcodeMap=needsPostcode.length?await postcodeBatchLookup({postcodes:needsPostcode}):new Map();
  const safeRadius=Math.max(1,Math.min(100,Number(radiusMiles)||25));
  const enriched=[];
  for(const event of events){
    let eventPoint=point(event.latitude,event.longitude);
    let distanceSource=eventPoint?"event_coordinates":null;
    if(!eventPoint&&event.postcode){
      const resolved=postcodeMap.get(postcodeKey(event.postcode));
      if(resolved?.status==="ok"){
        eventPoint=point(resolved.latitude,resolved.longitude);
        distanceSource="postcode_centroid";
      }
    }
    if(!eventPoint)continue;
    const distance=distanceMiles(origin,eventPoint);
    if(!Number.isFinite(distance)||distance>safeRadius)continue;
    enriched.push({
      ...event,
      latitude:event.latitude??eventPoint.latitude,
      longitude:event.longitude??eventPoint.longitude,
      distanceMiles:distance,
      distanceSource,
    });
  }
  return enriched;
}

function emptyRadarResult({types,tcg,radiusMiles,from,to,location}){
  return {
    success:true,
    generatedAt:new Date().toISOString(),
    query:{latitude:null,longitude:null,postcode:location?.postcode||null,radiusMiles,tcg:tcg||null,types,from,to:to||null},
    locationResolution:location,
    providers:{
      shops:{provider:"google_places",status:"location_unresolved"},
      localStock:{provider:"fatedrop_signal_events",status:"location_unresolved"},
      events:{provider:"fatedrop_encounters",status:"location_unresolved"},
    },
    shops:[],events:[],counts:{shops:0,events:0},
    disclaimers:[
      "The supplied location could not be resolved, so FateDrop did not label any shop or event as nearby.",
      "Discovered shops are location candidates, not FateDrop verification or stock evidence.",
      "Live Connected means FateDrop has a connected online catalogue. It does not prove stock at a specific physical branch.",
      "Verified local stock is only shown when branch-level official evidence is present and still fresh.",
      "Community or social evidence can create an Incoming Watch but can never be promoted to verified branch stock on its own.",
      "Event details can change; check the organiser or ticket source before travelling.",
    ],
  };
}

async function handleFateEncounters(req, res, { store, retailers, placesSearch, postcodeLookup, postcodeBatchLookup }) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && ["/api/encounters", "/api/calendar-events"].includes(url.pathname)) {
    const events = await listEncountersFromStore(store, eventFilters(url));
    return json(res, 200, { success:true,count:events.length,generatedAt:new Date().toISOString(),events,disclaimer:"Event details can change. Check the organiser or ticket source before travelling." });
  }

  const eventIdForVendors=vendorEventId(url.pathname);
  if(req.method==="GET"&&eventIdForVendors){
    const [vendors,inventory]=await Promise.all([listEncounterVendorsFromStore(store,eventIdForVendors),listEncounterInventoryFromStore(store,eventIdForVendors)]);
    const inventoryByVendor=new Map();
    for(const item of inventory){const rows=inventoryByVendor.get(item.vendorId)||[];rows.push(item);inventoryByVendor.set(item.vendorId,rows);}
    const enriched=vendors.map((vendor)=>({...vendor,inventory:inventoryByVendor.get(vendor.id)||[],inventoryCount:(inventoryByVendor.get(vendor.id)||[]).length}));
    return json(res,200,{success:true,eventId:eventIdForVendors,count:enriched.length,vendors:enriched,disclaimer:"Event stock is shown only from explicit event-vendor evidence and can change before or during the event."});
  }

  if (req.method === "GET" && (url.pathname.startsWith("/api/encounters/") || url.pathname.startsWith("/api/calendar-events/"))) {
    const id = decodeURIComponent(url.pathname.split("/").pop() || "");
    const events = await listEncountersFromStore(store, { from:null,to:null,tcgs:[],limit:2000 });
    const event = events.find((item) => item.id === id) || null;
    return event ? json(res, 200, { success:true,event }) : json(res, 404, { error:"Encounter not found" });
  }

  if (req.method === "GET" && url.pathname === "/api/local-radar") {
    const types = parseCsv(url.searchParams.get("types"));
    const requestedTypes=types.length?types:["shops","events"];
    const radiusMiles=optionalNumber(url.searchParams,"radiusMiles")||25;
    const tcg=url.searchParams.get("tcg")||null;
    const from=url.searchParams.get("from")||new Date().toISOString();
    const to=url.searchParams.get("to")||null;
    const location=await resolveRadarLocation(url,postcodeLookup);
    if(location.requested&&!location.origin){
      return json(res,200,emptyRadarResult({types:requestedTypes,tcg,radiusMiles,from,to,location:location.resolution}));
    }
    const radarStore = {
      listOffers:(options)=>store.listOffers(options),
      listEncounters:(options)=>listEncountersFromStore(store,options),
      ...(typeof store.listLocalStockObservations==="function"?{listLocalStockObservations:(options)=>store.listLocalStockObservations(options)}:{}),
      ...(typeof store.pool==="function"?{pool:()=>store.pool()}:{}),
    };
    const result = await buildLocalRadar({
      store:radarStore,retailers,placesApiKey:env.encounters.googlePlacesApiKey,placesSearch,
      latitude:location.origin?.latitude??null,longitude:location.origin?.longitude??null,postcode:location.resolution?.postcode||url.searchParams.get("postcode")||null,
      radiusMiles,tcg,types:requestedTypes,from,to,
    });
    const events=await distanceSafeEvents(result.events,{origin:location.origin,radiusMiles,postcodeBatchLookup});
    const response={
      ...result,
      events,
      counts:{...(result.counts||{}),shops:result.shops.length,events:events.length},
      locationResolution:location.resolution,
      disclaimers:[
        ...(result.disclaimers||[]),
        ...(location.origin?["Nearby event distances use venue coordinates where supplied, otherwise the event postcode centroid."]:[]),
      ],
    };
    return json(res,200,response);
  }

  if(req.method==="POST"&&url.pathname==="/internal/local-radar/locations"){
    if(!authorized(req))return json(res,401,{error:"Unauthorized"});
    const body=await readBody(req);
    const normalized=normalizeRetailerLocationBatch(body.locations||[]);
    if(!normalized.locations.length)return json(res,400,{error:"No valid retailer locations supplied",received:normalized.received,rejected:normalized.rejected});
    const persisted=await upsertRetailerLocationsIntoStore(store,normalized.locations);
    return json(res,200,{success:true,received:normalized.received,accepted:normalized.accepted,rejected:normalized.rejected,persisted});
  }

  if(req.method==="POST"&&url.pathname==="/internal/local-radar/observations"){
    if(!authorized(req))return json(res,401,{error:"Unauthorized"});
    const body=await readBody(req);
    const normalized=normalizeLocalStockObservationBatch(body.observations||[]);
    if(!normalized.observations.length)return json(res,400,{error:"No valid local stock observations supplied",received:normalized.received,rejected:normalized.rejected});
    const persisted=await upsertLocalStockObservationsIntoStore(store,normalized.observations);
    return json(res,200,{success:true,received:normalized.received,accepted:normalized.accepted,rejected:[...normalized.rejected,...(persisted.rejected||[])],persisted:{saved:persisted.saved||0,duplicates:persisted.duplicates||0}});
  }

  if(req.method==="POST"&&url.pathname==="/internal/encounters"){
    if(!authorized(req))return json(res,401,{error:"Unauthorized"});
    const body=await readBody(req);const normalized=normalizeEncounterBatch(body.events||[]);
    if(!normalized.events.length)return json(res,400,{error:"No valid encounters supplied",rejected:normalized.rejected});
    const persisted=await upsertEncountersIntoStore(store,normalized.events);
    return json(res,200,{success:true,persisted,received:normalized.received,accepted:normalized.accepted,unique:normalized.unique,rejected:normalized.rejected});
  }

  if(req.method==="POST"&&url.pathname==="/internal/encounter-vendors"){
    if(!authorized(req))return json(res,401,{error:"Unauthorized"});
    const body=await readBody(req);const normalized=normalizeVendorBatch(body.vendors||[]);
    if(!normalized.vendors.length)return json(res,400,{error:"No valid encounter vendors supplied",rejected:normalized.rejected});
    const persisted=await upsertEncounterVendorsIntoStore(store,normalized.vendors);
    return json(res,200,{success:true,persisted,received:normalized.received,accepted:normalized.accepted,rejected:normalized.rejected});
  }

  if(req.method==="POST"&&url.pathname==="/internal/encounter-inventory"){
    if(!authorized(req))return json(res,401,{error:"Unauthorized"});
    const body=await readBody(req);const normalized=normalizeInventoryBatch(body.inventory||[]);
    if(!normalized.inventory.length)return json(res,400,{error:"No valid encounter inventory supplied",rejected:normalized.rejected});
    const persisted=await upsertEncounterInventoryIntoStore(store,normalized.inventory);
    return json(res,200,{success:true,persisted,received:normalized.received,accepted:normalized.accepted,rejected:normalized.rejected});
  }

  return false;
}

export function createFateDropHttpServer({ store, retailers = [], placesSearch, postcodeLookup=lookupUkPostcode, postcodeBatchLookup=lookupUkPostcodes } = {}) {
  const server=createLegacyHttpServer({store});const legacyHandler=server.listeners("request")[0];server.removeAllListeners("request");
  const liveReadStore=createLiveOfferReadStore(store);
  const liveReadServer=createLegacyHttpServer({store:liveReadStore});const liveReadHandler=liveReadServer.listeners("request")[0];liveReadServer.removeAllListeners("request");
  const checkRateLimit=createRateLimiter();
  server.on("request",async(req,res)=>{try{
    const url=new URL(req.url||"/",`http://${req.headers.host||"localhost"}`);
    const rateLimit=checkRateLimit(req,url.pathname);
    if(!rateLimit.allowed)return rateLimited(res,rateLimit);
    if(req.method==="GET"&&url.pathname==="/api/signals"){await handlePublicSignals(req,res,{store});return;}
    if(req.method==="GET"&&url.pathname==="/api/signal-summary"){await handlePublicSignalSummary(req,res,{store});return;}
    if(req.method==="GET"&&url.pathname==="/api/alert-facets"){await handlePublicAlertFacets(req,res);return;}
    const isLiveRetailRead=(req.method==="GET"&&(url.pathname==="/api/catalogue"||url.pathname==="/api/true-price"))||(req.method==="POST"&&url.pathname==="/api/fatefind/matches");
    if(isLiveRetailRead){return liveReadHandler(req,res);}
    if(isFateTraderCataloguePath(url.pathname)){await handleFateTraderCatalogue(req,res,{store});return;}
    if(isFateTraderCollectionPath(url.pathname)){await handleFateTraderCollection(req,res,{store});return;}
    if(isFateTraderBinderPath(url.pathname)){await handleFateTraderBinder(req,res,{store});return;}
    if(isFateTraderMatchingPath(url.pathname)){await handleFateTraderMatching(req,res,{store});return;}
    if(isFateTraderTrustPath(url.pathname)){await handleFateTraderTrust(req,res,{store,internalSecret:env.ingestSecret});return;}
    if(isFateTraderSafeExchangePath(url.pathname)){await handleFateTraderSafeExchange(req,res,{store,internalSecret:env.ingestSecret});return;}
    const isEncounterRoute=url.pathname==="/api/local-radar"||url.pathname==="/api/encounters"||url.pathname.startsWith("/api/encounters/")||url.pathname==="/api/calendar-events"||url.pathname.startsWith("/api/calendar-events/")||url.pathname==="/internal/local-radar/locations"||url.pathname==="/internal/local-radar/observations"||url.pathname==="/internal/encounters"||url.pathname==="/internal/encounter-vendors"||url.pathname==="/internal/encounter-inventory";
    if(isEncounterRoute){await handleFateEncounters(req,res,{store:liveReadStore,retailers,placesSearch,postcodeLookup,postcodeBatchLookup});return;}
    return legacyHandler(req,res);
  }catch(error){return json(res,500,{error:"FateDrop route error",detail:process.env.NODE_ENV==="development"?String(error?.message||error):undefined});}});
  return server;
}
