import test from "node:test";
import assert from "node:assert/strict";
import { buildFateMatchNotification, evaluateFateFind, notificationDeliveryPlan, rankFateFindOffers, selectBestFateFindOffer } from "../src/hosted/fatefind.mjs";

const baseFind = { queryText:"Destined Rivals ETB",productIdentityId:null,maxItemPricePence:null,maxTruePricePence:null,maxPercentAboveRrp:null,preferredRetailerIds:[],excludedRetailerIds:[],stockRequirement:"in_stock",scope:"online" };
const product = { id:"prd_1",title:"Pokémon TCG Destined Rivals Elite Trainer Box",productType:"elite_trainer_box",tcg:"pokemon",officialRrpPence:4999,rrpSource:"pokemon-center-uk",rrpObservedAt:1780000000 };
const offer = { offerId:"off_1",productId:"prd_1",retailerId:"indie",retailerName:"Indie Cards",title:product.title,url:"https://example.test/p",pricePence:5299,postagePence:299,stockStatus:"in_stock" };

test("hosted FateFind treats ETB as Elite Trainer Box across retailer naming",()=>{
  const result=evaluateFateFind({...baseFind,maxTruePricePence:5600},offer,product);
  assert.equal(result.matched,true);
  assert.equal(result.deliveredPricePence,5598);
});

test("hosted FateFind treats plural ETBs as Elite Trainer Box",()=>{
  const result=evaluateFateFind({...baseFind,queryText:"Destined Rivals ETBs"},offer,product);
  assert.equal(result.matched,true);
});

test("ETB alias expansion does not remove the set-name requirement",()=>{
  const result=evaluateFateFind({...baseFind,queryText:"Journey Together ETB"},offer,product);
  assert.equal(result.matched,false);
  assert.deepEqual(result.reasons,["query-mismatch"]);
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

test("FateMatch stock alert uses Koru voice without hiding purchase facts",()=>{
  const notification=buildFateMatchNotification({find:baseFind,offer,product,result:{deliveredPricePence:5598}});
  assert.equal(notification.title,"Koru found stock · go get it");
  assert.match(notification.body,/Destined Rivals Elite Trainer Box/);
  assert.match(notification.body,/Indie Cards/);
  assert.match(notification.body,/£55\.98 delivered/);
  assert.equal(notification.payload.urgency,"high");
  assert.equal(notification.payload.companion,"Koru");
});

test("FateMatch preorder copy does not falsely claim live stock",()=>{
  const notification=buildFateMatchNotification({find:baseFind,offer:{...offer,stockStatus:"preorder"},product,result:{deliveredPricePence:5598}});
  assert.equal(notification.title,"Koru found it · your FateFind matched");
  assert.match(notification.body,/check preorder terms/);
  assert.doesNotMatch(notification.title,/found stock/);
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


test("FateFind ranking prefers the strongest legitimate RRP value, not the lowest raw item price",()=>{
  const products = new Map([
    ["a", { id:"a", title:"Pokemon TCG Destined Rivals Elite Trainer Box", productType:"elite_trainer_box", tcg:"pokemon", officialRrpPence:4999, rrpSource:"pokemon-center-uk", rrpObservedAt:1780000000 }],
    ["b", { id:"b", title:"Pokemon TCG Destined Rivals Elite Trainer Box", productType:"elite_trainer_box", tcg:"pokemon", officialRrpPence:3999, rrpSource:"authoritative-test", rrpObservedAt:1780000000 }],
  ]);
  const offers = [
    { ...offer, offerId:"off-a", productId:"a", retailerId:"retailer-a", retailerName:"Retailer A", pricePence:4499, postagePence:399, lastSeenAt:200 },
    { ...offer, offerId:"off-b", productId:"b", retailerId:"retailer-b", retailerName:"Retailer B", pricePence:4299, postagePence:0, lastSeenAt:300 },
  ];
  const ranked = rankFateFindOffers(baseFind, offers, products);
  assert.equal(ranked.length,2);
  assert.equal(ranked[0].offer.offerId,"off-a");
  assert.equal(ranked[0].result.percentAboveRrp,-10);
  assert.equal(ranked[1].result.percentAboveRrp,7.5);
  assert.equal(selectBestFateFindOffer(baseFind, offers, products).offer.offerId,"off-a");
});

test("FateFind uses a verified component reference for a retailer multipack",()=>{
  const loose = { id:"loose", title:"Pokemon TCG: Scarlet & Violet 10 - Destined Rivals Booster Pack", productType:"booster_pack", tcg:"pokemon", officialRrpPence:429, rrpSource:"asmodee-uk", rrpObservedAt:1780000000 };
  const bundle = { id:"bundle", title:"Destined Rivals - 10 Pack Bundle — Sealed", productType:"other", tcg:"pokemon", officialRrpPence:null, rrpSource:null };
  const bundleOffer = { ...offer, offerId:"bundle-offer", productId:"bundle", title:bundle.title, pricePence:3861, postagePence:null };
  const find = { ...baseFind, queryText:"Destined Rivals 10 Pack Bundle", maxPercentAboveRrp:0 };
  const ranked = rankFateFindOffers(find,[bundleOffer],new Map([["bundle",bundle],["loose",loose]]));
  assert.equal(ranked.length,1);
  assert.equal(ranked[0].result.rrpKind,"component_reference");
  assert.equal(ranked[0].result.rrpPence,4290);
  assert.equal(ranked[0].result.percentAboveRrp,-10);
  assert.equal(ranked[0].result.deliveredPricePence,null);
});

test("FateFind fails an RRP threshold closed when UK RRP is not applicable",()=>{
  const imported = { id:"jp", title:"Pokemon Mega Brave Japanese Booster Box", productType:"booster_box", tcg:"pokemon", officialRrpPence:null, rrpSource:null };
  const importedOffer = { ...offer, productId:"jp", title:imported.title, pricePence:5999, postagePence:0 };
  const find = { ...baseFind, queryText:"Mega Brave Japanese Booster Box", maxPercentAboveRrp:10 };
  const result = evaluateFateFind(find, importedOffer, imported);
  assert.equal(result.matched,false);
  assert.deepEqual(result.reasons,["rrp-not-applicable"]);
  assert.equal(result.rrpApplicabilityReason,"non_uk_import");
});
