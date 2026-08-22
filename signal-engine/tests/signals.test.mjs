import test from "node:test";
import assert from "node:assert/strict";
import { deriveSignal } from "../src/core/signals.mjs";

const offer = (status, extra={}) => ({ offerId:"off_1",productId:"prd_1",retailerId:"chaos-cards",retailerName:"Chaos Cards",title:"Example ETB",productType:"elite_trainer_box",url:"https://example.test/p",pricePence:4999,rrpPence:4999,postagePence:null,stockStatus:status,stockConfidence:0.99,evidence:[],everAvailableAt:null,...extra });

function signalKindEvidence(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "signal_kind") ?? null;
}

test("quiet baseline emits no signal",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),isBaseline:true,now:100}),null));
test("new unavailable catalogue listing whispers with a precise catalogue_new cause",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200});
  assert.equal(signal.state,"whisper");
  assert.equal(signal.kind,"catalogue_new");
  assert.equal(signalKindEvidence(signal)?.value,"catalogue_new");
});
test("preorder catalogue movement whispers with catalogue_state_change",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("preorder"),now:200});
  assert.equal(signal.state,"whisper");
  assert.equal(signal.kind,"catalogue_state_change");
});
test("unavailable to first verified availability manifests precisely",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"availability_live");
});
test("previously available return manifests as restock",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock",{everAvailableAt:50}),currentOffer:offer("in_stock",{everAvailableAt:50}),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"restock");
});
test("new live catalogue listing records new_listing_live",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"new_listing_live");
});
test("available to unavailable vanishes as sold_out",()=>{
  const signal=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50}),currentOffer:offer("out_of_stock",{everAvailableAt:50}),now:200});
  assert.equal(signal.state,"vanished");
  assert.equal(signal.kind,"sold_out");
});
test("catalogue derivation never invents Echo because Echo belongs to traffic/security readiness intelligence",()=>{
  const states=[
    deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200})?.state,
    deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("preorder"),now:201})?.state,
    deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:202})?.state,
  ];
  assert.equal(states.includes("echo"),false);
});
test("signals carry a canonical product navigation target",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:200});
  assert.deepEqual(signal.target,{type:"product",productId:"prd_1",offerId:"off_1",retailerId:"chaos-cards",productUrl:"https://example.test/p",query:"Example ETB"});
});
