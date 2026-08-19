import test from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/http/server.mjs";

const store={
  async listOffers(){return[
    {offerId:"retailer-a:sku-1",productId:"product-1",retailerId:"retailer-a",retailerName:"Retailer A",retailerSku:"sku-1",title:"Destined Rivals Elite Trainer Box",url:"https://example.com/a",imageUrl:null,pricePence:5499,postagePence:399,stockStatus:"in_stock",stockConfidence:1,lastSeenAt:1776768000},
    {offerId:"retailer-b:sku-2",productId:"product-1",retailerId:"retailer-b",retailerName:"Retailer B",retailerSku:"sku-2",title:"Destined Rivals Elite Trainer Box",url:"https://example.com/b",imageUrl:null,pricePence:5799,postagePence:0,stockStatus:"in_stock",stockConfidence:1,lastSeenAt:1776768000},
  ];},
  async listProducts(){return[{id:"product-1",title:"Destined Rivals Elite Trainer Box",productType:"sealed",officialRrpPence:4999}];},
  async stats(){return{productsTracked:1,offersTracked:2,currentlyAvailable:2};},
  async listRetailers(){return[{id:"retailer-a",name:"Retailer A",healthy:true,baselineCompleted:true}];},
  async listSignals(){return[];},
  async listNetworkSnapshots(){return[];},
};

async function withServer(fn){const server=createHttpServer({store});await new Promise((resolve)=>server.listen(0,"127.0.0.1",resolve));try{const address=server.address();await fn(`http://127.0.0.1:${address.port}`);}finally{await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}}

test("app catalogue exposes mobile-compatible offers",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/catalogue?q=destined&inStock=true`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.success,true);assert.equal(data.total,2);assert.equal(data.products[0].availability,"IN_STOCK");assert.equal(data.products[0].category,"SEALED");}));

test("true price compares known delivered totals",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/true-price?q=destined`);assert.equal(response.status,200);const data=await response.json();assert.equal(data.groups.length,1);assert.equal(data.groups[0].retailerCount,2);const lowest=data.groups[0].offers.find((offer)=>offer.isLowestKnownDelivered);assert.equal(lowest.id,"retailer-b:sku-2");assert.equal(lowest.totalDeliveredGbp,57.99);}));

test("status summarizes hosted store",async()=>withServer(async(base)=>{const response=await fetch(`${base}/api/status`);const data=await response.json();assert.equal(data.monitor.baselineComplete,true);assert.equal(data.monitor.productsTracked,1);assert.equal(data.monitor.currentlyAvailable,2);}));
