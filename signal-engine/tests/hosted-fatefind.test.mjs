import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFateFind, notificationDeliveryPlan } from "../src/hosted/fatefind.mjs";

const baseFind = { queryText:"Destined Rivals ETB",productIdentityId:null,maxItemPricePence:null,maxTruePricePence:null,maxPercentAboveRrp:null,preferredRetailerIds:[],excludedRetailerIds:[],stockRequirement:"in_stock",scope:"online" };
const product = { id:"prd_1",title:"Pokémon TCG Destined Rivals Elite Trainer Box ETB",officialRrpPence:4999 };
const offer = { offerId:"off_1",productId:"prd_1",retailerId:"indie",retailerName:"Indie Cards",title:product.title,url:"https://example.test/p",pricePence:5299,postagePence:299,stockStatus:"in_stock" };

test("hosted FateFind matches query, stock and known True Price",()=>{
  const result=evaluateFateFind({...baseFind,maxTruePricePence:5600},offer,product);
  assert.equal(result.matched,true);
  assert.equal(result.deliveredPricePence,5598);
});

test("unknown delivery never satisfies a True Price ceiling",()=>{
  const result=evaluateFateFind({...baseFind,maxTruePricePence:6000},{...offer,postagePence:null},product);
  assert.equal(result.matched,false);
  assert.deepEqual(result.reasons,["delivery-unknown"]);
});

test("above-RRP ceiling uses observed item price against official RRP",()=>{
  assert.equal(evaluateFateFind({...baseFind,maxPercentAboveRrp:5},offer,product).matched,false);
  assert.equal(evaluateFateFind({...baseFind,maxPercentAboveRrp:7},offer,product).matched,true);
});

test("excluded retailer never creates a FateMatch",()=>{
  assert.equal(evaluateFateFind({...baseFind,excludedRetailerIds:["indie"]},offer,product).matched,false);
});

test("local scope fails closed until Signal Engine offers carry canonical locations",()=>{
  const result=evaluateFateFind({...baseFind,scope:"local"},offer,product);
  assert.equal(result.matched,false);
  assert.deepEqual(result.reasons,["local-offer-location-unavailable"]);
});

test("FateMatch master preference suppresses every delivery channel",()=>{
  const plan=notificationDeliveryPlan({fate_match_enabled:false,web_enabled:true,push_enabled:true,discord_enabled:true},{website:true,app:true,discord:true},1000);
  assert.deepEqual(plan.enabled,{web:false,push:false,discord:false});
  assert.equal(plan.quietUntil,null);
});

test("quiet hours defer push and Discord while leaving web history immediately available",()=>{
  const now=Math.floor(Date.UTC(2026,7,19,23,30,0)/1000);
  const plan=notificationDeliveryPlan({fate_match_enabled:true,web_enabled:true,push_enabled:true,discord_enabled:true,quiet_hours_enabled:true,quiet_hours_start:"22:00",quiet_hours_end:"07:00",timezone:"UTC"},{website:true,app:true,discord:true},now);
  assert.deepEqual(plan.enabled,{web:true,push:true,discord:true});
  assert.equal(plan.nextAttemptAt.web,now);
  assert.equal(plan.nextAttemptAt.push,now+(7.5*60*60));
  assert.equal(plan.nextAttemptAt.discord,now+(7.5*60*60));
  assert.equal(plan.quietUntil,now+(7.5*60*60));
});

test("outside quiet hours notifications are eligible immediately",()=>{
  const now=Math.floor(Date.UTC(2026,7,19,12,0,0)/1000);
  const plan=notificationDeliveryPlan({fate_match_enabled:true,web_enabled:true,push_enabled:true,discord_enabled:true,quiet_hours_enabled:true,quiet_hours_start:"22:00",quiet_hours_end:"07:00",timezone:"UTC"},{website:true,app:true,discord:true},now);
  assert.equal(plan.nextAttemptAt.web,now);
  assert.equal(plan.nextAttemptAt.push,now);
  assert.equal(plan.nextAttemptAt.discord,now);
  assert.equal(plan.quietUntil,null);
});
