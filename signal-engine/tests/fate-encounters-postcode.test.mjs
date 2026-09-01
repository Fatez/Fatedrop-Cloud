import test from "node:test";
import assert from "node:assert/strict";
import { createFateDropHttpServer } from "../src/http/fatedrop-server.mjs";

const events = [
  {
    id: "enc_near",
    canonicalKey: "near|2027-01-10|BB11BB",
    itemType: "event",
    name: "Nearby Card Show",
    startDateTime: "2027-01-10T10:00:00Z",
    postcode: "BB1 1BB",
    latitude: null,
    longitude: null,
    supportedTcgs: ["pokemon"],
  },
  {
    id: "enc_far",
    canonicalKey: "far|2027-01-10|CC11CC",
    itemType: "event",
    name: "Far Away Card Show",
    startDateTime: "2027-01-10T10:00:00Z",
    postcode: "CC1 1CC",
    latitude: null,
    longitude: null,
    supportedTcgs: ["pokemon"],
  },
];

const store = {
  async listOffers() { return []; },
  async listEncounters() { return events; },
  async stats() { return { productsTracked:0,offersTracked:0,currentlyAvailable:0 }; },
  async listRetailers() { return []; },
  async listProducts() { return []; },
  async listSignals() { return []; },
  async listNetworkSnapshots() { return []; },
};

function compact(value){return String(value||"").replace(/\s+/g,"").toUpperCase();}

async function postcodeLookup({postcode}){
  if(compact(postcode)==="AA11AA")return{status:"ok",source:"postcodes_io",postcode:"AA1 1AA",latitude:51.5,longitude:-0.1};
  return{status:"invalid",source:"postcodes_io",postcode:String(postcode||"").toUpperCase(),latitude:null,longitude:null};
}

async function postcodeBatchLookup({postcodes}){
  const result=new Map();
  for(const postcode of postcodes){
    if(compact(postcode)==="BB11BB")result.set(compact(postcode),{status:"ok",source:"postcodes_io",postcode:"BB1 1BB",latitude:51.505,longitude:-0.105});
    else if(compact(postcode)==="CC11CC")result.set(compact(postcode),{status:"ok",source:"postcodes_io",postcode:"CC1 1CC",latitude:53.48,longitude:-2.24});
    else result.set(compact(postcode),{status:"invalid",source:"postcodes_io",postcode,latitude:null,longitude:null});
  }
  return result;
}

async function placesSearch(){
  return{status:"ok",provider:"google_places",shops:[
    {id:"google:near",itemType:"shop",provider:"google_places",providerPlaceId:"near",name:"Nearby TCG",latitude:51.506,longitude:-0.106,verificationStatus:"discovered",discoveryScope:"candidate-only",networkStatus:"local_indie",retailerId:null,localStockStatus:"unknown",stockEvidence:"none",onlineCatalogue:null,sourceAttribution:"Google Places"},
    {id:"google:far",itemType:"shop",provider:"google_places",providerPlaceId:"far",name:"Far TCG",latitude:53.48,longitude:-2.24,verificationStatus:"discovered",discoveryScope:"candidate-only",networkStatus:"local_indie",retailerId:null,localStockStatus:"unknown",stockEvidence:"none",onlineCatalogue:null,sourceAttribution:"Google Places"},
  ]};
}

async function withServer(fn,{places=placesSearch,lookup=postcodeLookup,batchLookup=postcodeBatchLookup}={}){
  const server=createFateDropHttpServer({store,retailers:[],placesSearch:places,postcodeLookup:lookup,postcodeBatchLookup:batchLookup});
  await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));
  try{const address=server.address();await fn(`http://127.0.0.1:${address.port}`);}finally{await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
}

test("postcode-only Local Radar resolves an origin, hides provisional shops and radius-filters events",async()=>withServer(async(base)=>{
  const response=await fetch(`${base}/api/local-radar?postcode=AA1%201AA&radiusMiles=25&types=shops,events&from=2027-01-01T00:00:00Z`);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.locationResolution.status,"ok");
  assert.equal(data.locationResolution.source,"postcodes_io");
  assert.equal(data.shops.length,0);
  assert.equal(data.events.length,1);
  assert.equal(data.events[0].name,"Nearby Card Show");
  assert.equal(data.events[0].distanceSource,"postcode_centroid");
  assert.ok(data.events[0].distanceMiles>0&&data.events[0].distanceMiles<25);
}));

test("an invalid postcode fails closed instead of returning unverified nearby claims",async()=>{
  let placesCalled=false;
  await withServer(async(base)=>{
    const response=await fetch(`${base}/api/local-radar?postcode=NOT-A-POSTCODE&radiusMiles=25&types=shops,events`);
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.locationResolution.status,"invalid");
    assert.deepEqual(data.shops,[]);
    assert.deepEqual(data.events,[]);
    assert.deepEqual(data.counts,{shops:0,events:0});
  },{places:async()=>{placesCalled=true;return placesSearch();}});
  assert.equal(placesCalled,false);
});

test("partial device coordinates do not get treated as a valid nearby origin",async()=>withServer(async(base)=>{
  const response=await fetch(`${base}/api/local-radar?lat=51.5&radiusMiles=25&types=events`);
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.locationResolution.status,"invalid");
  assert.equal(data.counts.events,0);
}));
