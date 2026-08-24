import test from "node:test";
import assert from "node:assert/strict";
import { deriveSignal } from "../src/core/signals.mjs";

const offer = (status, extra={}) => ({ offerId:"off_1",productId:"prd_1",retailerId:"chaos-cards",retailerName:"Chaos Cards",retailerSku:"SKU-123",title:"Example ETB",productType:"elite_trainer_box",url:"https://example.test/p",pricePence:4999,rrpPence:4999,postagePence:null,stockStatus:status,stockConfidence:0.99,evidence:[],everAvailableAt:null,...extra });

function kind(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "signal_kind")?.value ?? null;
}

function alertClass(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "signal_alert_class")?.value ?? null;
}

function retailerSku(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "retailer_sku")?.value ?? null;
}

test("quiet baseline emits no signal",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),isBaseline:true,now:100}),null));
test("new unavailable retailer SKU whispers with exact catalogue cause",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200});
  assert.equal(signal.state,"whisper");
  assert.equal(signal.kind,"catalogue_new");
  assert.equal(kind(signal),"catalogue_new");
});
test("preorder catalogue movement whispers",()=>assert.equal(deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("preorder"),now:200}).state,"whisper"));
test("unavailable to available manifests as availability live",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"availability_live");
});
test("previously available return manifests as restock",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock",{everAvailableAt:50}),currentOffer:offer("in_stock",{everAvailableAt:50}),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"restock");
});
test("available to unavailable does not publish an orphan Vanished",()=>{
  const signal=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50}),currentOffer:offer("out_of_stock",{everAvailableAt:50}),now:200});
  assert.equal(signal,null);
});
test("available to unavailable vanishes only when it closes an open Manifested window",()=>{
  const signal=deriveSignal({
    previousOffer:offer("in_stock",{everAvailableAt:50}),
    currentOffer:offer("out_of_stock",{everAvailableAt:50}),
    now:200,
    availabilityWindow:{id:"avw_1",manifestedSignalId:"sig_manifested_1",manifestedAt:100},
  });
  assert.equal(signal.state,"vanished");
  assert.equal(signal.kind,"sold_out");
  assert.equal(signal.availabilityWindowId,"avw_1");
  assert.equal(signal.pairedManifestedSignalId,"sig_manifested_1");
  const windowEvidence=signal.evidence.find((entry)=>entry?.kind==="availability_window");
  assert.equal(windowEvidence?.status,"closed");
  assert.equal(windowEvidence?.manifestedSignalId,"sig_manifested_1");
});
test("catalogue derivation never invents Echo because Echo belongs to traffic/security readiness intelligence",()=>{
  const states=[
    deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200})?.state,
    deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("preorder"),now:201})?.state,
    deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:202})?.state,
  ];
  assert.equal(states.includes("echo"),false);
});
test("market retailers carry market_stock alert class",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200});
  assert.equal(signal.alertClass,"market_stock");
  assert.equal(alertClass(signal),"market_stock");
});
test("primary RRP retailers carry primary_drop alert class",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("coming_soon",{retailerId:"smyths-uk",retailerName:"Smyths Toys UK"}),now:200});
  assert.equal(signal.alertClass,"primary_drop");
  assert.equal(signal.signalCapabilities.dropSentinel,true);
  assert.equal(alertClass(signal),"primary_drop");
});
test("signals expose and persist retailer SKU identity",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200});
  assert.equal(signal.retailerSku,"SKU-123");
  assert.equal(retailerSku(signal),"SKU-123");
});
test("signals carry a canonical product navigation target",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:200});
  assert.deepEqual(signal.target,{type:"product",productId:"prd_1",offerId:"off_1",retailerId:"chaos-cards",productUrl:"https://example.test/p",query:"Example ETB"});
});
