function text(value) {
  return value == null ? '' : String(value).trim();
}

export const FAIR_PRICE_METHODOLOGIES = Object.freeze({
  'fair-price-v1': Object.freeze({
    key: 'fair-price-v1',
    status: 'research',
    consumerEnabled: false,
    description: 'Reserved FateDrop Fair Price methodology. Must be calibrated and explicitly approved before consumer use.',
  }),
});

export function getFairPriceMethodology(key) {
  return FAIR_PRICE_METHODOLOGIES[text(key)] ?? null;
}

export function assertFairPriceMethodologyApproved(key) {
  const methodology = getFairPriceMethodology(key);
  if (!methodology) {
    const error = new Error('Fair Price methodology is unknown');
    error.code = 'FAIR_PRICE_METHODOLOGY_UNKNOWN';
    throw error;
  }
  if (methodology.status !== 'calibrated' || methodology.consumerEnabled !== true) {
    const error = new Error('Fair Price methodology is not calibrated for consumer use');
    error.code = 'FAIR_PRICE_NOT_CALIBRATED';
    throw error;
  }
  return methodology;
}

/**
 * Promote a precomputed candidate to the canonical Fair Price contract only
 * after its methodology has been calibrated and explicitly enabled.
 *
 * This function deliberately does not calculate Fair Price. The calculation
 * methodology must be developed/backtested separately; this is the publication
 * gate that prevents raw provider prices from being relabelled as Fair Price.
 */
export function publishFairPriceCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('Fair Price candidate is required');
  }
  const methodology = assertFairPriceMethodologyApproved(candidate.methodologyKey);
  const cardIdentityId = text(candidate.cardIdentityId ?? candidate.fateCardId);
  if (!cardIdentityId) throw new TypeError('cardIdentityId is required');
  const amount = Number(candidate.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError('amount must be non-negative');
  const currencyCode = text(candidate.currencyCode).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError('currencyCode must be a 3-letter currency code');
  const asOf = Number(candidate.asOf ?? candidate.observedAt);
  if (!Number.isFinite(asOf) || asOf <= 0) throw new TypeError('asOf must be a positive timestamp');

  return Object.freeze({
    status: 'available',
    reason: null,
    valuationKind: 'fair-price',
    cardIdentityId,
    fateCardId: cardIdentityId,
    amount: Number(amount.toFixed(2)),
    currencyCode,
    observedAt: asOf,
    sourceEffectiveAt: asOf,
    methodologyKey: methodology.key,
  });
}
