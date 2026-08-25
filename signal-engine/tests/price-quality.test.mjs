import test from "node:test";
import assert from "node:assert/strict";

import { calculateOfferIntelligence, sortOffersByTruePrice } from "../src/core/price-intelligence.mjs";
import { PriceQuality, classifyObservedPrice } from "../src/core/price-quality.mjs";

test("zero and one-penny observations are preserved but never canonical commercial prices", () => {
  for (const pricePence of [0, 1]) {
    const result = classifyObservedPrice({ pricePence, retailerId: "eterna-cards" });
    assert.equal(result.rawObservedPricePence, pricePence);
    assert.equal(result.canonicalPricePence, null);
    assert.equal(result.priceQuality, PriceQuality.PLACEHOLDER);
  }
});

test("ordinary positive prices remain valid without changing commercial math", () => {
  const result = classifyObservedPrice({ pricePence: 4999 });
  assert.equal(result.priceQuality, PriceQuality.VALID);
  assert.equal(result.canonicalPricePence, 4999);
});

test("placeholder observations cannot calculate RRP savings or True Price", () => {
  const result = calculateOfferIntelligence({ pricePence: 1, postagePence: 299, officialRrpPence: 4999 });
  assert.equal(result.priceKnown, false);
  assert.equal(result.priceQuality, PriceQuality.PLACEHOLDER);
  assert.equal(result.canonicalPricePence, null);
  assert.equal(result.deliveredPence, null);
  assert.equal(result.itemVsRrp.deltaPence, null);
  assert.equal(result.itemVsRrp.deltaPercent, null);
  assert.equal(result.itemVsRrp.aboveRrp, null);
});

test("placeholder raw price cannot outrank a valid commercial offer", () => {
  const offers = [
    { id: "sentinel", pricePence: 1, intelligence: calculateOfferIntelligence({ pricePence: 1, postagePence: 0 }) },
    { id: "real", pricePence: 4999, intelligence: calculateOfferIntelligence({ pricePence: 4999, postagePence: 0 }) },
  ];
  assert.deepEqual(sortOffersByTruePrice(offers).map((offer) => offer.id), ["real", "sentinel"]);
});
