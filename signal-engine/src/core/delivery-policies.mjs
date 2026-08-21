const VERIFIED_AT = "2026-08-21";

const policies = {
  "pokemon-center-uk": {
    source: "https://support.pokemoncenter.com/hc/en-us/articles/4410136975892-Pok%C3%A9mon-Center-UK-FAQ",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 2000,
    rules: [
      { minSubtotalPence: 2000, postagePence: 0 },
      { minSubtotalPence: 0, postagePence: 500 },
    ],
  },
  "smyths-uk": {
    source: "https://www.smythstoys.com/uk/en-gb/shipping-and-delivery",
    verifiedAt: VERIFIED_AT,
    collectionAvailable: true,
    freeShippingThresholdPence: 2000,
    rules: [
      { minSubtotalPence: 2000, postagePence: 0 },
      { minSubtotalPence: 1000, postagePence: 299 },
      { minSubtotalPence: 0, postagePence: 499 },
    ],
  },
  "hamleys-uk": {
    source: "https://www.hamleys.com/delivery-policy",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 4500,
    rules: [
      { minSubtotalPence: 4500, postagePence: 0 },
      { minSubtotalPence: 1500, postagePence: 399 },
      { minSubtotalPence: 0, postagePence: 499 },
    ],
  },
  "game-uk": {
    source: "https://help.game.co.uk/support/solutions/articles/80001148014-delivery-options",
    verifiedAt: VERIFIED_AT,
    standardPence: 499,
  },
  "argos-uk": {
    source: "https://www.argos.co.uk/features/argos-plus",
    verifiedAt: VERIFIED_AT,
    standardPence: 495,
    collectionAvailable: true,
    note: "Standard small-item delivery; TCG catalogue items are treated as small items unless product evidence says otherwise.",
  },
  "eterna-cards": {
    source: "https://eternacards.co.uk/pages/shipping-policy",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 20000,
    rules: [
      { minSubtotalPence: 20000, postagePence: 0 },
      { minSubtotalPence: 8000, postagePence: 195 },
      { minSubtotalPence: 0, postagePence: 295 },
    ],
  },
  "jet-cards": {
    source: "https://jetcards.uk/pages/shipping-information",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 10001,
    collectionAvailable: true,
    rules: [
      { minSubtotalPence: 10001, postagePence: 0 },
      { minSubtotalPence: 0, postagePence: 350 },
    ],
  },
  "chaos-cards": {
    source: "https://www.chaoscards.co.uk/delivery",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 3001,
    rules: [{ minSubtotalPence: 3001, postagePence: 0 }],
    note: "Below the free-shipping threshold, checkout options vary; do not invent a flat charge.",
  },
  "magic-madhouse": {
    source: "https://magicmadhouse.co.uk/",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 4000,
    rules: [{ minSubtotalPence: 4000, postagePence: 0 }],
    note: "Below the free-economy threshold, delivery method and charge vary.",
  },
  "double-sleeved": {
    source: "https://www.doublesleeved.co.uk/pages/contact-us",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 3001,
    rules: [{ minSubtotalPence: 3001, postagePence: 0 }],
    note: "Tracked 48 is advertised free above £30; below-threshold pricing is not treated as fixed.",
  },
  "titan-cards": {
    source: "https://titancards.co.uk/pages/delivery-information",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 3000,
    rules: [{ minSubtotalPence: 3000, postagePence: 0 }],
    note: "Below £30, postage follows Royal Mail tariff/format and is therefore not assumed from price alone.",
  },
  "card-collective": {
    source: "https://card-collective.com/",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 8000,
    rules: [{ minSubtotalPence: 8000, postagePence: 0 }],
    note: "Below £80, shipping is calculated at checkout based on location/order size.",
  },
  "entertainer-uk": {
    source: "https://www.thetoyshop.com/",
    verifiedAt: VERIFIED_AT,
    freeShippingThresholdPence: 4000,
    collectionAvailable: true,
    rules: [{ minSubtotalPence: 4000, postagePence: 0 }],
    note: "Public site confirms free delivery above £39.99; below-threshold standard charge is not treated as fixed without stronger evidence.",
  },
  "total-cards": {
    source: "https://totalcards.net/pages/delivery/",
    verifiedAt: VERIFIED_AT,
    collectionAvailable: true,
    note: "Rates vary by parcel class and some products are excluded from free shipping; resolve from product/checkout evidence rather than a blanket rate.",
  },
  "asda-uk": {
    verifiedAt: VERIFIED_AT,
    note: "Grocery delivery is slot/postcode/order dependent; keep delivery unknown unless the retailer feed provides an exact charge.",
  },
  "tesco-uk": {
    verifiedAt: VERIFIED_AT,
    note: "Grocery delivery is slot/postcode/order dependent; keep delivery unknown unless the retailer feed provides an exact charge.",
  },
  "gathering-games": {
    verifiedAt: VERIFIED_AT,
    note: "No sufficiently authoritative public fixed-rate evidence captured yet.",
  },
  "zatu-games": {
    verifiedAt: VERIFIED_AT,
    note: "No sufficiently authoritative public fixed-rate evidence captured yet.",
  },
};

export function deliveryPolicyFor(retailerId) {
  return policies[retailerId] || null;
}

export function resolveRetailerDelivery({ retailerId, subtotalPence } = {}) {
  const policy = deliveryPolicyFor(retailerId);
  const subtotalKnown = Number.isFinite(subtotalPence) && subtotalPence >= 0;
  if (!policy) return { known: false, postagePence: null, collectionAvailable: false };

  let postagePence = null;
  if (subtotalKnown && Array.isArray(policy.rules)) {
    const rule = [...policy.rules]
      .sort((a, b) => b.minSubtotalPence - a.minSubtotalPence)
      .find((candidate) => subtotalPence >= candidate.minSubtotalPence);
    if (rule && Number.isFinite(rule.postagePence) && rule.postagePence >= 0) postagePence = Math.round(rule.postagePence);
  } else if (Number.isFinite(policy.standardPence) && policy.standardPence >= 0) {
    postagePence = Math.round(policy.standardPence);
  }

  return {
    known: Number.isFinite(postagePence),
    postagePence,
    freeShippingThresholdPence: Number.isFinite(policy.freeShippingThresholdPence) ? policy.freeShippingThresholdPence : null,
    collectionAvailable: policy.collectionAvailable === true,
    source: policy.source || null,
    verifiedAt: policy.verifiedAt || null,
    note: policy.note || null,
  };
}
