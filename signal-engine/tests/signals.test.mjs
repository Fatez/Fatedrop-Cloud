import test from "node:test";
import assert from "node:assert/strict";
import { deriveSignal, deriveSignals } from "../src/core/signals.mjs";

const verifiedEvidence = [
  { kind: "structured_catalogue", value: "present" },
  { kind: "verified_stock_api", value: "authoritative_stock" },
];

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

test("quiet baseline emits no signal",()=>assert.equal(deriveSignal({previousOffer:null,currentOffer:offer("in_stock"),isBaseline:true,now:100}),null));

test("new unavailable retailer SKU whispers with exact catalogue cause",()=>{
  const signal=deriveSignal({previousOffer:null,currentOffer:offer("coming_soon"),now:200});
  assert.equal(signal.state,"whisper");
  assert.equal(signal.kind,"catalogue_new");
  assert.equal(kind(signal),"catalogue_new");
});

test("preorder catalogue movement whispers",()=>assert.equal(deriveSignal({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("preorder",{lastSeenAt:200}),now:200}).state,"whisper"));

test("unverified unavailable to in-stock remains Whisper only",()=>{
  const signals=deriveSignals({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("in_stock",{lastSeenAt:200}),now:200});
  assert.deepEqual(signals.map((signal)=>signal.state),["whisper"]);
  assert.equal(signals[0].stockStatus,"in_stock");
});

test("verified unavailable to available records Whisper plus Manifested availability live",()=>{
  const signals=deriveSignals({
    previousOffer:offer("out_of_stock",{lastSeenAt:150}),
    currentOffer:offer("in_stock",{evidence:verifiedEvidence,lastSeenAt:200}),
    now:200,
  });
  assert.deepEqual(signals.map((signal)=>signal.state),["whisper","manifested"]);
  assert.equal(signals[1].kind,"availability_live");
});

test("previously available verified return records Whisper plus Manifested restock",()=>{
  const signals=deriveSignals({
    previousOffer:offer("out_of_stock",{everAvailableAt:50,lastSeenAt:150}),
    currentOffer:offer("in_stock",{everAvailableAt:50,evidence:verifiedEvidence,lastSeenAt:200}),
    now:200,
  });
  assert.deepEqual(signals.map((signal)=>signal.state),["whisper","manifested"]);
  assert.equal(signals[1].kind,"restock");
});

test("verified available to unavailable records Whisper plus Vanished with auditable prior-live state",()=>{
  const signals=deriveSignals({
    previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:150,evidence:verifiedEvidence}),
    currentOffer:offer("out_of_stock",{everAvailableAt:50,lastSeenAt:200}),
    now:200,
  });
  assert.deepEqual(signals.map((signal)=>signal.state),["whisper","vanished"]);
  const signal=signals[1];
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

test("available to unavailable never Vanishes when prior live was unverified",()=>{
  const signals=deriveSignals({
    previousOffer:offer("in_stock",{everAvailableAt:null,lastSeenAt:150}),
    currentOffer:offer("out_of_stock",{lastSeenAt:200}),
    now:200,
  });
  assert.deepEqual(signals.map((signal)=>signal.state),["whisper"]);
});

test("Vanished fails closed when verified prior-live provenance is incomplete",()=>{
  const missingObservedAt=deriveSignals({
    previousOffer:offer("in_stock",{everAvailableAt:50,lastSeenAt:null,evidence:verifiedEvidence}),
    currentOffer:offer("out_of_stock",{everAvailableAt:50,lastSeenAt:200}),
    now:200,
  });
  const missingFirstAvailable=deriveSignals({
    previousOffer:offer("in_stock",{everAvailableAt:null,lastSeenAt:150,evidence:verifiedEvidence}),
    currentOffer:offer("out_of_stock",{lastSeenAt:200}),
    now:200,
  });
  assert.equal(missingObservedAt.some((signal)=>signal.state==="vanished"),false);
  assert.equal(missingFirstAvailable.some((signal)=>signal.state==="vanished"),false);
});

test("ordinary catalogue monitoring does not invent Echo",()=>{
  const states=[
    ...deriveSignals({previousOffer:null,currentOffer:offer("coming_soon"),now:200}).map((signal)=>signal.state),
    ...deriveSignals({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("preorder",{lastSeenAt:201}),now:201}).map((signal)=>signal.state),
    ...deriveSignals({previousOffer:offer("out_of_stock",{lastSeenAt:150}),currentOffer:offer("in_stock",{lastSeenAt:202}),now:202}).map((signal)=>signal.state),
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
  const signal=deriveSignal({
    previousOffer:offer("out_of_stock",{lastSeenAt:150}),
    currentOffer:offer("in_stock",{evidence:verifiedEvidence,lastSeenAt:200}),
    now:200,
  });
  assert.equal(signal.state,"manifested");
  assert.deepEqual(signal.target,{type:"product",productId:"prd_1",offerId:"off_1",retailerId:"chaos-cards",productUrl:"https://example.test/p",query:"Example ETB"});
});
