import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.mjs";
import { createFateDropHttpServer } from "../src/http/fatedrop-server.mjs";

const savedEvents = [];
const savedVendors = [];
const savedInventory = [];
const store = {
  async listOffers() {
    return [
      { retailerId: "indie-live", stockStatus: "in_stock" },
      { retailerId: "indie-live", stockStatus: "preorder" },
      { retailerId: "other", stockStatus: "out_of_stock" },
    ];
  },
  async listEncounters({ from = null } = {}) {
    const fromTime = from ? Date.parse(from) : 0;
    return savedEvents.filter((event) => Date.parse(event.startDateTime) >= fromTime);
  },
  async upsertEncounters(events) {
    for (const event of events) {
      const index = savedEvents.findIndex((item) => item.canonicalKey === event.canonicalKey);
      if (index >= 0) savedEvents[index] = event;
      else savedEvents.push(event);
    }
    return { saved: events.length };
  },
  async upsertEncounterVendors(vendors){for(const vendor of vendors){const index=savedVendors.findIndex((item)=>item.id===vendor.id);if(index>=0)savedVendors[index]=vendor;else savedVendors.push(vendor);}return{saved:vendors.length};},
  async listEncounterVendors(eventId){return savedVendors.filter((vendor)=>vendor.eventId===eventId);},
  async upsertEncounterInventory(items){for(const item of items){const index=savedInventory.findIndex((row)=>row.id===item.id);if(index>=0)savedInventory[index]=item;else savedInventory.push(item);}return{saved:items.length};},
  async listEncounterInventory(eventId){return savedInventory.filter((item)=>item.eventId===eventId);},
  async stats() { return { productsTracked: 0, offersTracked: 0, currentlyAvailable: 0 }; },
  async listRetailers() { return []; },
  async listProducts() { return []; },
  async listSignals() { return []; },
  async listNetworkSnapshots() { return []; },
};

const retailers = [{ id: "indie-live", name: "Live Cards", baseUrl: "https://livecards.example/" }];

async function placesSearch() {
  return {status:"ok",provider:"google_places",shops:[
    {id:"google:live",itemType:"shop",provider:"google_places",providerPlaceId:"live",name:"Live Cards",websiteUrl:"https://livecards.example/shop",latitude:51.5,longitude:-0.1,verificationStatus:"discovered",discoveryScope:"candidate-only",networkStatus:"local_indie",retailerId:null,localStockStatus:"unknown",stockEvidence:"none",onlineCatalogue:null,sourceAttribution:"Google Places"},
    {id:"google:tiny",itemType:"shop",provider:"google_places",providerPlaceId:"tiny",name:"Tiny TCG",websiteUrl:"https://tinytcg.example/",latitude:51.51,longitude:-0.11,verificationStatus:"discovered",discoveryScope:"candidate-only",networkStatus:"local_indie",retailerId:null,localStockStatus:"unknown",stockEvidence:"none",onlineCatalogue:null,sourceAttribution:"Google Places"},
  ]};
}

async function withServer(fn) {
  const server = createFateDropHttpServer({ store, retailers, placesSearch });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { const address=server.address(); await fn(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve())); }
}

test("local radar distinguishes discovered shops from connected online catalogue evidence", async () => withServer(async (base) => {
  const response=await fetch(`${base}/api/local-radar?lat=51.5&lng=-0.1&radiusMiles=25&types=shops`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.success,true);assert.equal(data.shops.length,2);
  const connected=data.shops.find((shop)=>shop.retailerId==="indie-live");assert.equal(connected.networkStatus,"live_connected");assert.equal(connected.localStockStatus,"unknown");assert.equal(connected.stockEvidence,"online_catalogue_only");assert.equal(connected.onlineCatalogue.availableOffers,2);assert.equal(connected.onlineCatalogue.scope,"online-catalogue-not-branch-stock");
  const discovered=data.shops.find((shop)=>shop.providerPlaceId==="tiny");assert.equal(discovered.networkStatus,"local_indie");assert.equal(discovered.stockEvidence,"none");
}));

test("protected encounter intake deduplicates an event and exposes it in the UK calendar", async () => {
  const previousSecret=env.ingestSecret;env.ingestSecret="test-secret";savedEvents.length=0;
  try { await withServer(async(base)=>{
    const event={name:"Small Town Card Show",startDateTime:"2027-02-20T10:00:00Z",venueName:"Town Hall",townCity:"Exampleton",postcode:"AB1 2CD",supportedTcgs:["pokemon","one-piece"],sourceType:"organiser_submission",verificationStatus:"source_verified",sourceUrl:"https://organiser.example/events/card-show"};
    const unauthorized=await fetch(`${base}/internal/encounters`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({events:[event]})});assert.equal(unauthorized.status,401);
    const ingest=await fetch(`${base}/internal/encounters`,{method:"POST",headers:{"content-type":"application/json","x-fatedrop-secret":"test-secret"},body:JSON.stringify({events:[event,{...event,categories:["card-show"]}]})});assert.equal(ingest.status,200);const result=await ingest.json();assert.equal(result.unique,1);assert.equal(savedEvents.length,1);
    const calendar=await fetch(`${base}/api/encounters?from=2027-01-01T00:00:00Z&tcg=pokemon`);assert.equal(calendar.status,200);const data=await calendar.json();assert.equal(data.count,1);assert.equal(data.events[0].name,"Small Town Card Show");assert.deepEqual(data.events[0].categories,["card-show"]);
  }); } finally { env.ingestSecret=previousSecret; }
});

test("event vendors and event inventory require explicit evidence and are exposed per encounter",async()=>{
  const previousSecret=env.ingestSecret;env.ingestSecret="test-secret";savedVendors.length=0;savedInventory.length=0;
  try{await withServer(async(base)=>{
    const eventId="enc_test_event";
    const vendorIngest=await fetch(`${base}/internal/encounter-vendors`,{method:"POST",headers:{"content-type":"application/json","x-fatedrop-secret":"test-secret"},body:JSON.stringify({vendors:[{eventId,name:"Vendor One",retailerId:"indie-live",stallLabel:"A12",supportedTcgs:["pokemon"],verificationStatus:"source_verified",sourceType:"organiser_submission",sourceUrl:"https://organiser.example/vendors"}]})});
    assert.equal(vendorIngest.status,200);const vendorResult=await vendorIngest.json();assert.equal(vendorResult.accepted,1);const vendorId=savedVendors[0].id;
    const stockIngest=await fetch(`${base}/internal/encounter-inventory`,{method:"POST",headers:{"content-type":"application/json","x-fatedrop-secret":"test-secret"},body:JSON.stringify({inventory:[{eventId,vendorId,title:"Destined Rivals Elite Trainer Box",pricePence:4999,quantity:4,availability:"available",evidenceScope:"event_vendor_submission",observedAt:"2027-02-19T12:00:00Z",expiresAt:"2027-02-21T00:00:00Z"}]})});
    assert.equal(stockIngest.status,200);
    const response=await fetch(`${base}/api/encounters/${eventId}/vendors`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.count,1);assert.equal(data.vendors[0].stallLabel,"A12");assert.equal(data.vendors[0].inventoryCount,1);assert.equal(data.vendors[0].inventory[0].evidenceScope,"event_vendor_submission");assert.equal(data.vendors[0].inventory[0].quantity,4);
  });}finally{env.ingestSecret=previousSecret;}
});
