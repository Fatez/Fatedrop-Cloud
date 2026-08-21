import test from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/http/server.mjs";

const signalRows = [
  {id:"sig-w",state:"whisper",productId:"product-1",offerId:"retailer-a:sku-1",retailerId:"retailer-a",retailerName:"Retailer A",title:"Destined Rivals Elite Trainer Box",productType:"sealed",url:"https://example.com/a",pricePence:5499,rrpPence:4999,markupPercent:10,stockStatus:"coming_soon",confidence:.7,detectedAt:1776767900,reason:"Catalogue movement"},
  {id:"sig-e",state:"echo",productId:"product-1",offerId:"retailer-a:sku-1",retailerId:"retailer-a",retailerName:"Retailer A",title:"Destined Rivals Elite Trainer Box",productType:"sealed",url:"https://example.com/a",pricePence:5499,rrpPence:4999,markupPercent:10,stockStatus:"coming_soon",confidence:.85,detectedAt:1776768000,reason:"Queue and security behaviour changed"},
  {id:"sig-m",state:"manifested",productId:"product-1",offerId:"retailer-b:sku-2",retailerId:"retailer-b",retailerName:"Retailer B",title:"Destined Rivals Elite Trainer Box",productType:"sealed",url:"https://example.com/b",pricePence:5799,rrpPence:4999,markupPercent:16,stockStatus:"in_stock",confidence:1,detectedAt:1776768100,reason:"Available",target:{type:"product",productId:"product-1",offerId:"retailer-b:sku-2",retailerId:"retailer-b",productUrl:"https://example.com/b",query:"Destined Rivals Elite Trainer Box"}},
  {id:"sig-v",state:"vanished",productId:"product-1",offerId:"retailer-b:sku-2",retailerId:"retailer-b",retailerName:"Retailer B",title:"Destined Rivals Elite Trainer Box",productType:"sealed",url:"https://example.com/b",pricePence:5799,rrpPence:4999,markupPercent:16,stockStatus:"out_of_stock",confidence:1,detectedAt:1776768200,reason:"No longer available"},
  {id:"sig-other",state:"network",productId:"product-2",title:"Internal network event",detectedAt:1776767800},
];

const store={
  async listOffers(){return[
    {offerId:"retailer-a:sku-1",productId:"product-1",retailerId:"retailer-a",retailerName:"Retailer A",retailerSku:"sku-1",title:"Destined Rivals Elite Trainer Box",url:"https://example.com/a",imageUrl:null,pricePence:5499,postagePence:399,stockStatus:"in_stock",stockConfidence:1,lastSeenAt:1776768000},
    {offerId:"retailer-b:sku-2",productId:"product-1",retailerId:"retailer-b",retailerName:"Retailer B",retailerSku:"sku-2",title:"Destined Rivals Elite Trainer Box",url:"https://example.com/b",imageUrl:null,pricePence:5799,postagePence:0,stockStatus:"in_stock",stockConfidence:1,lastSeenAt:1776768000},
    {offerId:"retailer-c:sku-4",productId:"product-3",retailerId:"retailer-c",retailerName:"Retailer C",retailerSku:"sku-4",title:"Pokemon TCG Destined Rivals Elite Trainer Box",url:"https://example.com/c",imageUrl:null,pricePence:4499,postagePence:null,stockStatus:"in_stock",stockConfidence:1,lastSeenAt:1776768000},
    {offerId:"pokemon-center-uk:sku-3",productId:"product-2",retailerId:"pokemon-center-uk",retailerName:"Pokémon Center UK",retailerSku:"sku-3",title:"Journey Together Booster Bundle",url:"https://example.com/pc",imageUrl:null,pricePence:1899,postagePence:null,stockStatus:"in_stock",stockConfidence:1,lastSeenAt:1776768000},
  ];},
  async listProducts(){return[
    {id:"product-1",title:"Destined Rivals Elite Trainer Box",productType:"sealed",tcg:"pokemon",officialRrpPence:4999,rrpSource:"pokemon-center-uk",rrpObservedAt:1776767000},
    {id:"product-2",title:"Journey Together Booster Bundle",productType:"sealed",tcg:"pokemon",officialRrpPence:1899,rrpSource:"pokemon-center-uk",rrpObservedAt:1776767000},
    {id:"product-3",title:"Pokemon TCG Destined Rivals Elite Trainer Box",productType:"sealed",tcg:"pokemon",officialRrpPence:null,rrpSource:null,rrpObservedAt:null},
  ];},
  async stats(){return{productsTracked:3,offersTracked:4,currentlyAvailable:4};},
  async listRetailers(){return[{id:"retailer-a",name:"Retailer A",healthy:true,baselineCompleted:true}];},
  async listSignals({states=[],retailerIds=[],since=0,limit=100}={}){
    return signalRows
      .filter((signal)=>signal.detectedAt>=since)
      .filter((signal)=>!states.length||states.includes(signal.state))
      .filter((signal)=>!retailerIds.length||retailerIds.includes(signal.retailerId))
      .slice(0,limit);
  },
  async listNetworkSnapshots(){return[];},
};

async function withServer(fn){const server=createHttpServer({store});await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));try{const address=server.address();await fn(`http://127.0.0.1:${address.port}`);}finally{await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}}

test("app catalogue exposes mobile-compatible offers with RRP provenance",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/catalogue?q=destined&inStock=true`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.success,true);assert.equal(data.total,3);assert.equal(data.products[0].availability,"IN_STOCK");assert.equal(data.products[0].category,"SEALED");}));

test("true price compares known delivered totals and carries product RRP evidence",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/true-price?q=destined`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.groups.length,1);assert.equal(data.groups[0].retailerCount,3);assert.equal(data.groups[0].rrpGbp,49.99);assert.equal(data.groups[0].rrpSource,"pokemon-center-uk");assert.ok(data.groups[0].rrpObservedAt);const inherited=data.groups[0].offers.find((offer)=>offer.id==="retailer-c:sku-4");assert.equal(inherited.priceGbp,44.99);const lowest=data.groups[0].offers.find((offer)=>offer.isLowestKnownDelivered);assert.equal(lowest.id,"retailer-b:sku-2");assert.equal(lowest.totalDeliveredGbp,57.99);}));

test("true price resolves verified delivery for an existing offer with no stored postage",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/true-price?q=journey`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.groups.length,1);const offer=data.groups[0].offers[0];assert.equal(offer.retailerId,"pokemon-center-uk");assert.equal(offer.shippingGbp,5);assert.equal(offer.totalDeliveredGbp,23.99);assert.equal(offer.deliveryKnown,true);assert.equal(offer.freeShippingThresholdGbp,20);assert.equal(offer.isLowestKnownDelivered,true);}));

test("public signal feed exposes exactly the four canonical lifecycle states",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/signals?limit=10`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.success,true);assert.equal(data.count,4);assert.deepEqual(data.signals.map((signal)=>signal.state),["whisper","echo","manifested","vanished"]);for(const signal of data.signals){assert.equal(signal.target.type,"product");assert.equal(signal.target.productId,"product-1");}assert.equal(data.signals[0].rrpGbp,49.99);assert.equal(data.signals[2].target.offerId,"retailer-b:sku-2");}));

test("public signal feed can filter Whisper independently",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/signals?state=whisper`);const data=await response.json();assert.deepEqual(data.signals.map((signal)=>signal.state),["whisper"]);}));

test("status summarizes hosted store",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/status`);const data=await response.json();assert.equal(data.monitor.baselineComplete,true);assert.equal(data.monitor.productsTracked,3);assert.equal(data.monitor.currentlyAvailable,4);}));
