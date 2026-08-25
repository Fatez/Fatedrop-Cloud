export const PriceQuality = Object.freeze({
  VALID: "valid",
  UNKNOWN: "unknown",
  PLACEHOLDER: "placeholder",
  SUSPICIOUS: "suspicious",
  INVALID: "invalid",
});

function finiteInteger(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value);
}

export function classifyObservedPrice({ pricePence = null, retailerId = null, evidence = [] } = {}) {
  const rawObservedPricePence = finiteInteger(pricePence);
  const base = {
    rawObservedPricePence,
    canonicalPricePence: null,
    priceQuality: PriceQuality.UNKNOWN,
    priceConfidence: 0,
    priceEvidence: [],
  };

  if (rawObservedPricePence === null) {
    return { ...base, priceEvidence: [{ kind: "price_missing", value: "no_finite_observed_price" }] };
  }

  if (rawObservedPricePence < 0) {
    return {
      ...base,
      priceQuality: PriceQuality.INVALID,
      priceEvidence: [{ kind: "price_invalid", value: "negative_observed_price", rawObservedPricePence }],
    };
  }

  // £0 and £0.01 are never accepted as commercial truth for FateDrop's TCG
  // offers. They remain preserved as raw observations because they can be useful
  // preparation evidence. Lifecycle promotion is contextual and lives elsewhere.
  if (rawObservedPricePence === 0 || rawObservedPricePence === 1) {
    const structuredKinds = (Array.isArray(evidence) ? evidence : [])
      .map((entry) => String(entry?.kind || ""))
      .filter(Boolean);
    return {
      ...base,
      priceQuality: PriceQuality.PLACEHOLDER,
      priceConfidence: 0.05,
      priceEvidence: [{
        kind: "price_placeholder",
        value: rawObservedPricePence === 0 ? "zero_price" : "one_penny_sentinel",
        rawObservedPricePence,
        retailerId: retailerId || null,
        structuredEvidenceKinds: structuredKinds,
      }],
    };
  }

  return {
    rawObservedPricePence,
    canonicalPricePence: rawObservedPricePence,
    priceQuality: PriceQuality.VALID,
    priceConfidence: 0.99,
    priceEvidence: [{ kind: "price_valid", value: "positive_commercial_price", rawObservedPricePence }],
  };
}

export function isCommercialPrice(priceOrClassification) {
  const classification = priceOrClassification && typeof priceOrClassification === "object" && "priceQuality" in priceOrClassification
    ? priceOrClassification
    : classifyObservedPrice({ pricePence: priceOrClassification });
  return classification.priceQuality === PriceQuality.VALID && Number.isFinite(classification.canonicalPricePence);
}

export function commercialPricePence(priceOrClassification) {
  const classification = priceOrClassification && typeof priceOrClassification === "object" && "priceQuality" in priceOrClassification
    ? priceOrClassification
    : classifyObservedPrice({ pricePence: priceOrClassification });
  return isCommercialPrice(classification) ? classification.canonicalPricePence : null;
}
