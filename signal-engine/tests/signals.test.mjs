import test from "node:test";
import assert from "node:assert/strict";
import { deriveSignal } from "../src/core/signals.mjs";

const offer = (status, extra={}) => ({ offerId:"off_1",productId:"prd_1",retailerId:"chaos-cards",retailerName:"Chaos Cards",title:"Example ETB",productType:"elite_trainer_box",url:"https://example.test/p",pricePence:4999,rrpPence:4999,postagePence:null,stockStatus:status,stockConfidence:0.99,evidence:[],everAvailableAt:null,...extra });

test("quiet baseline emits no signal",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),isBaseline:true,now:100}),null));
test("unavailable to available manifests",()=>assert.equal(deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:200}).state,"manifested"));
test("previously available return manifests again",()=>assert.equal(deriveSignal({previousOffer:offer("out_of_stock",{everAvailableAt:50}),currentOffer:offer("in_stock",{everAvailableAt:50}),now:200}).state,"manifested"));
test("available to unavailable vanishes",()=>assert.equal(deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50}),currentOffer:offer("out_of_stock",{everAvailableAt:50}),now:200}).state,"vanished"));
test("new coming-soon listing becomes echo",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200}).state,"echo"));
test("preorder activity becomes echo",()=>assert.equal(deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("preorder"),now:200}).state,"echo"));
test("signals carry a canonical product navigation target",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock"),currentOffer:offer("in_stock"),now:200});
  assert.deepEqual(signal.target,{type:"product",productId:"prd_1",offerId:"off_1",retailerId:"chaos-cards",productUrl:"https://example.test/p",query:"Example ETB"});
});
