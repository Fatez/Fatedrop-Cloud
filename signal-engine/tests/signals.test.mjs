import test from "node:test";
import assert from "node:assert/strict";
import { deriveSignal, deriveSignals } from "../src/core/signals.mjs";

const offer = (status, extra={}) => ({
  offerId:"off_1",
  productId:"prd_1",
  retailerId:"chaos-cards",
  retailerName:"Chaos Cards",
  retailerSku:"SKU-123",
  title:"Example ETB",
  productType:"elite_trainer_box",
  url:"https://example.test/p",
  pricePence:4999,
  rrpPence:4999,
  postagePence:null,
  stockStatus:status,
  stockConfidence:0.99,
  evidence:[{ kind: "structured_catalogue", value: "present" }],
  everAvailableAt:null,
  firstSeenAt:100,
  lastSeenAt:null,
  ...extra,
});

function kind(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "signal_kind")?.value ?? null;
}

function alertClass(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "signal_alert_class")?.value ?? null;
}

function retailerSku(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "retailer_sku")?.value ?? null;
}

function priorLive(signal) {
  return signal?.evidence?.find((entry) => entry?.kind === "prior_live_confirmation") ?? null;
}

test("quiet baseline persists a Manifested history anchor without alert delivery",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),isBaseline:true,now:100});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"baseline_live_anchor");
  assert.equal(signal.deliverySuppressed,true);
  assert.equal(signal.evidence.some((entry)=>entry?.kind==="delivery_policy"&&entry?.value==="history_only"),true);
});

test("quiet baseline still emits nothing for unavailable stock",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("out_of_stock"),isBaseline:true,now:100}),null));

test("already-live persisted offer without an active Manifested anchor is reconciled once",()=>{
  const signal=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:150,lifecycleHistoryLoaded:true,latestManifestedAt:null,latestVanishedAt:null}),currentOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:200}),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"reconciled_live_anchor");
  assert.equal(signal.deliverySuppressed,true);
});

test("already-live offer with an active Manifested anchor does not duplicate the lifecycle start",()=>{
  const signal=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:150,lifecycleHistoryLoaded:true,latestManifestedAt:120,latestVanishedAt:null}),currentOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:200}),now:200});
  assert.equal(signal,null);
});

test("new unavailable retailer SKU whispers with exact catalogue cause",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200});
  assert.equal(signal.state,"whisper");
  assert.equal(signal.kind,"catalogue_new");
  assert.equal(kind(signal),"catalogue_new");
});

test("preorder catalogue movement whispers",()=>assert.equal(deriveSignal({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("preorder",{lastSeenAt:200}),now:200}).state,"whisper"));

test("verified unavailable to available becomes Manifested availability live",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("in_stock",{lastSeenAt:200}),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"availability_live");
  assert.deepEqual(deriveSignals({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("in_stock",{lastSeenAt:200}),now:200}).map((item)=>item.state),["manifested"]);
});

test("previously available return becomes Manifested restock",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock",{everAvailableAt:50,lastSeenAt:150}),currentOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:200}),now:200});
  assert.equal(signal.state,"manifested");
  assert.equal(signal.kind,"restock");
});

test("available to unavailable becomes Vanished with auditable prior-live state",()=>{
  const signal=deriveSignal({
    previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:150}),
    currentOffer:offer("out_of_stock",{everAvailableAt:50,lastSeenAt:200}),
    now:200,
  });
  assert.equal(signal.state,"vanished");
  assert.equal(signal.kind,"sold_out");
  assert.deepEqual(priorLive(signal),{
    kind:"prior_live_confirmation",
    value:"persisted_purchasable_offer",
    observedAt:150,
    firstAvailableAt:50,
    stockStatus:"in_stock",
    confidence:0.99,
  });
});

test("Vanished fails closed when prior-live provenance is incomplete",()=>{
  const missingObservedAt=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:null}),currentOffer:offer("out_of_stock",{everAvailableAt:50,lastSeenAt:200}),now:200});
  const missingFirstAvailable=deriveSignal({previousOffer:offer("in_stock",{everAvailableAt:null,lastSeenAt:150}),currentOffer:offer("out_of_stock",{lastSeenAt:200}),now:200});
  assert.equal(missingObservedAt,null);
  assert.equal(missingFirstAvailable,null);
});

test("purchase-verification-required in-stock wording remains Whisper until the control is verified",()=>{
  const signal=deriveSignal({
    previousOffer:null,
    currentOffer:offer("in_stock",{evidence:[
      {kind:"official_retailer_catalogue_listing",value:"verified"},
      {kind:"purchase_verification_required",value:"required"},
    ]}),
    now:200,
  });
  assert.equal(signal.state,"whisper");
});

test("ordinary catalogue preparation does not invent Echo",()=>{
  const states=[
    deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200})?.state,
    deriveSignal({previousOffer:null,currentOffer:offer("preorder",{evidence:[{kind:"official_retailer_product_page",value:"https://example.test/p"},{kind:"preorder_metadata",value:"soon"}]}),now:201})?.state,
    deriveSignal({previousOffer:null,currentOffer:offer("out_of_stock",{evidence:[{kind:"structured_catalogue",value:"present"},{kind:"inventory_metadata",value:"exposed"},{kind:"launch_date",value:"2026-09-01"}]}),now:202})?.state,
  ];
  assert.equal(states.includes("echo"),false);
  assert.deepEqual(states,["whisper","whisper","whisper"]);
});

test("price movement before verified availability is Whisper",()=>{
  const signal=deriveSignal({previousOffer:offer("out_of_stock",{pricePence:null,lastSeenAt:150}),currentOffer:offer("out_of_stock",{pricePence:4999,lastSeenAt:200}),now:200});
  assert.equal(signal.state,"whisper");
  assert.equal(signal.kind,"catalogue_price_change");
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
  const signal=deriveSignal({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("in_stock",{lastSeenAt:200}),now:200});
  assert.equal(signal.state,"manifested");
  assert.deepEqual(signal.target,{type:"product",productId:"prd_1",offerId:"off_1",retailerId:"chaos-cards",productUrl:"https://example.test/p",query:"Example ETB"});
});
