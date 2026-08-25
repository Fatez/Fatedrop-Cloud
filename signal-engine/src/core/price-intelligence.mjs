import { classifyObservedPrice } from "./price-quality.mjs";

export function calculateOfferIntelligence({ pricePence, postagePence = null, officialRrpPence = null, rrpSource = null, rrpObservedAt = null, retailerId = null, evidence = [] } = {}) {
  const price = classifyObservedPrice({ pricePence, retailerId, evidence });
  const priceKnown = Number.isFinite(price.canonicalPricePence);
  const canonicalPricePence = priceKnown ? price.canonicalPricePence : null;
  const deliveryKnown = Number.isFinite(postagePence) && postagePence >= 0;
  const rrpKnown = Number.isFinite(officialRrpPence) && officialRrpPence > 0;
  const deliveredPence = priceKnown && deliveryKnown ? canonicalPricePence + postagePence : null;
  const itemDeltaPence = priceKnown && rrpKnown ? canonicalPricePence - officialRrpPence : null;
  const itemDeltaPercent = itemDeltaPence === null ? null : (itemDeltaPence / officialRrpPence) * 100;
  const deliveredDeltaPence = deliveredPence !== null && rrpKnown ? deliveredPence - officialRrpPence : null;
  const deliveredDeltaPercent = deliveredDeltaPence === null ? null : (deliveredDeltaPence / officialRrpPence) * 100;
  return {
    priceKnown,
    rawObservedPricePence: price.rawObservedPricePence,
    canonicalPricePence,
    priceQuality: price.priceQuality,
    priceConfidence: price.priceConfidence,
    priceEvidence: price.priceEvidence,
    deliveryKnown,
    deliveredPence,
    rrp: {
      known: rrpKnown,
      pence: rrpKnown ? officialRrpPence : null,
      source: rrpKnown ? rrpSource : null,
      observedAt: rrpKnown ? rrpObservedAt : null,
    },
    itemVsRrp: {
      deltaPence: itemDeltaPence,
      deltaPercent: itemDeltaPercent,
      aboveRrp: itemDeltaPence === null ? null : itemDeltaPence > 0,
    },
    deliveredVsRrp: {
      deltaPence: deliveredDeltaPence,
      deltaPercent: deliveredDeltaPercent,
      aboveRrp: deliveredDeltaPence === null ? null : deliveredDeltaPence > 0,
    },
  };
}

export function sortOffersByTruePrice(offers = []) {
  return [...offers].sort((a, b) => {
    const aKnown = Number.isFinite(a?.intelligence?.deliveredPence);
    const bKnown = Number.isFinite(b?.intelligence?.deliveredPence);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aKnown && bKnown) return a.intelligence.deliveredPence - b.intelligence.deliveredPence;
    const aPrice = Number.isFinite(a?.intelligence?.canonicalPricePence) ? a.intelligence.canonicalPricePence : Infinity;
    const bPrice = Number.isFinite(b?.intelligence?.canonicalPricePence) ? b.intelligence.canonicalPricePence : Infinity;
    return aPrice - bPrice;
  });
}

export function summariseMarketOffers(offers = []) {
  const valid = offers.filter((offer) => offer && offer.intelligence);
  const delivered = valid.filter((offer) => Number.isFinite(offer.intelligence.deliveredPence));
  const aboveRrp = valid.filter((offer) => offer.intelligence.itemVsRrp.aboveRrp === true);
  const highestPremium = valid
    .map((offer) => offer.intelligence.itemVsRrp.deltaPercent)
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), -Infinity);
  return {
    offerCount: valid.length,
    knownDeliveredCount: delivered.length,
    cheapestDeliveredPence: delivered.length ? Math.min(...delivered.map((offer) => offer.intelligence.deliveredPence)) : null,
    aboveRrpCount: aboveRrp.length,
    highestItemPremiumPercent: Number.isFinite(highestPremium) ? highestPremium : null,
  };
}
