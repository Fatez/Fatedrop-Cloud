function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

export function previousRetailerProductsSeen(retailers = [], retailerId) {
  const row = (Array.isArray(retailers) ? retailers : []).find((item) => item?.id === retailerId);
  return finiteCount(row?.productsSeen);
}

export function catalogueCompletenessDecision({
  retailer = {},
  observedProducts = 0,
  previousProductsSeen = null,
  partialCatalogue = false,
  collapseRatio = 0.5,
  minimumPreviousProducts = 10,
  minimumMissingProducts = 5,
} = {}) {
  const observed = finiteCount(observedProducts) ?? 0;
  const previous = finiteCount(previousProductsSeen);
  const expected = finiteCount(retailer?.monitoring?.expectedMinimumProducts ?? retailer?.expectedMinimumProducts);
  const allowIncompleteReplacement = retailer?.monitoring?.allowIncompleteReplacement === true
    || retailer?.allowIncompleteReplacement === true;

  if (allowIncompleteReplacement) {
    return { acceptable: true, reason: "incomplete_replacement_explicitly_allowed", observed, previous, expected };
  }

  if (partialCatalogue === true) {
    return { acceptable: false, reason: "partial_catalogue", observed, previous, expected };
  }

  if (expected !== null && observed < expected) {
    return { acceptable: false, reason: "below_expected_minimum", observed, previous, expected };
  }

  if (previous !== null && previous >= minimumPreviousProducts) {
    const missing = Math.max(0, previous - observed);
    const ratio = previous > 0 ? observed / previous : 1;
    if (missing >= minimumMissingProducts && ratio < collapseRatio) {
      return { acceptable: false, reason: "suspicious_catalogue_collapse", observed, previous, expected, missing, ratio };
    }
  }

  return { acceptable: true, reason: "complete_enough", observed, previous, expected };
}
