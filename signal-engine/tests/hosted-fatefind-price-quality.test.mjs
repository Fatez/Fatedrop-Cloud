import test from "node:test";
import assert from "node:assert/strict";

import { evaluateFateFind } from "../src/hosted/fatefind.mjs";

const find = {
  productIdentityId: null,
  queryText: "Delta Reign Elite Trainer Box",
  preferredRetailerIds: [],
  excludedRetailerIds: [],
  stockRequirement: "in_stock",
  maxItemPricePence: null,
  maxTruePricePence: null,
  maxPercentAboveRrp: null,
  scope: "either",
};

const product = {
  id: "prd_delta_etb",
  title: "Pokemon Delta Reign Elite Trainer Box",
  officialRrpPence: 4999,
};

function offer(pricePence) {
  return {
    offerId: "off_delta_etb",
    productId: product.id,
    retailerId: "eterna-cards",
    retailerName: "Eterna Cards",
    title: product.title,
    url: "https://example.test/delta-reign-etb",
    pricePence,
    postagePence: 299,
    stockStatus: "in_stock",
  };
}

test("one-penny placeholder cannot become a FateFind winner even when retailer stock metadata says in stock", () => {
  const result = evaluateFateFind(find, offer(1), product);
  assert.equal(result.matched, false);
  assert.deepEqual(result.reasons, ["price-not-commercial"]);
  assert.equal(result.priceQuality, "placeholder");
});

test("zero-price placeholder cannot become a FateFind winner", () => {
  const result = evaluateFateFind(find, offer(0), product);
  assert.equal(result.matched, false);
  assert.deepEqual(result.reasons, ["price-not-commercial"]);
});

test("valid commercial price still follows the existing FateFind rules", () => {
  const result = evaluateFateFind(find, offer(4499), product);
  assert.equal(result.matched, true);
  assert.equal(result.deliveredPricePence, 4798);
  assert.equal(result.percentAboveRrp, -10);
});
