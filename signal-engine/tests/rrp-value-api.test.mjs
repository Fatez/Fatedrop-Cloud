import test from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/http/server.mjs";

const store = {
  async listOffers() {
    return [
      { offerId:"card-collective:10", productId:"bundle-10", retailerId:"card-collective", retailerName:"Card Collective UK", retailerSku:"10", title:"Destined Rivals - 10 Pack Bundle — Sealed", url:"https://example.com/10", pricePence:16695, postagePence:0, stockStatus:"in_stock", lastSeenAt:1_780_000_000 },
      { offerId:"card-collective:4", productId:"bundle-4", retailerId:"card-collective", retailerName:"Card Collective UK", retailerSku:"4", title:"Destined Rivals - 4 Pack Bundle — Sealed", url:"https://example.com/4", pricePence:6695, postagePence:null, stockStatus:"in_stock", lastSeenAt:1_780_000_000 },
    ];
  },
  async listProducts() {
    return [
      { id:"bundle-10", title:"Destined Rivals - 10 Pack Bundle — Sealed", productType:"other", tcg:"pokemon", officialRrpPence:null, rrpSource:null, rrpObservedAt:null },
      { id:"bundle-4", title:"Destined Rivals - 4 Pack Bundle — Sealed", productType:"other", tcg:"pokemon", officialRrpPence:null, rrpSource:null, rrpObservedAt:null },
      { id:"official-pack", title:"Pokémon TCG: Scarlet & Violet-Destined Rivals Sleeved Booster Pack (10 Cards)", productType:"booster_pack", tcg:"pokemon", officialRrpPence:499, rrpSource:"pokemon-center-uk", rrpObservedAt:1_780_000_000 },
    ];
  },
  async stats() { return { productsTracked:3, offersTracked:2, currentlyAvailable:2 }; },
  async listRetailers() { return []; },
  async listSignals() { return []; },
  async listNetworkSnapshots() { return []; },
};

async function withServer(fn) {
  const server = createHttpServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("catalogue exposes safe component RRP references and unit counts for retailer multipacks", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/catalogue?q=destined&inStock=true`);
  const data = await response.json();
  assert.equal(data.success, true);
  const ten = data.products.find((offer) => offer.id === "card-collective:10");
  const four = data.products.find((offer) => offer.id === "card-collective:4");
  assert.equal(ten.rrpGbp, 49.9);
  assert.equal(ten.rrpKind, "component_reference");
  assert.equal(ten.unitCount, 10);
  assert.equal(ten.unitRrpGbp, 4.99);
  assert.equal(four.rrpGbp, 19.96);
  assert.equal(four.unitCount, 4);
}));

test("True Price keeps 4-pack and 10-pack as separate products while normalising both to verified pack value", async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/true-price?q=destined`);
  const data = await response.json();
  assert.equal(data.groups.length, 2);
  const ten = data.groups.find((group) => group.id === "bundle-10");
  const four = data.groups.find((group) => group.id === "bundle-4");
  assert.equal(ten.rrpGbp, 49.9);
  assert.equal(ten.rrpReferenceBasis, "10 × verified booster-pack RRP");
  assert.equal(four.rrpGbp, 19.96);
  assert.equal(four.rrpReferenceBasis, "4 × verified booster-pack RRP");
}));
