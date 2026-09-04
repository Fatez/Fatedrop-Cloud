function text(value) {
  return value == null ? '' : String(value).trim();
}

function money(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be a non-negative finite number`);
  return number;
}

function currency(value) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currencyCode must be a 3-letter currency code');
  return code;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundPercent(value) {
  return Number(value.toFixed(2));
}

export const FATEDROP_MARKET_STANCE = Object.freeze({
  mode: 'observational_only',
  financialAdvice: false,
  forecasts: false,
  recommendations: false,
  principle: 'reflect_the_market_do_not_direct_the_user',
});

/**
 * Public collector pricing intentionally hides internal evidence-quality and
 * provider-policy machinery. Those fields decide whether a price is eligible;
 * they are not part of the consumer-facing price object.
 */
export function toPublicKnownPrice(price) {
  if (!price || price.status === 'unavailable') return null;
  const amount = money(price.amount, 'price.amount');
  const currencyCode = currency(price.currencyCode);
  const asOf = price.sourceEffectiveAt ?? price.observedAt ?? null;
  return Object.freeze({
    kind: 'known_price',
    amount: roundMoney(amount),
    currencyCode,
    asOf: asOf == null ? null : Number(asOf),
  });
}

/**
 * Compare an observed asking/offer price with an established reference price.
 * This is descriptive only. It never emits buy/sell language or a prediction.
 */
export function computeObservedPricePosition({
  observedPrice,
  referencePrice,
  currencyCode,
  referenceKind = 'fair_price',
  nearPercent = 2,
} = {}) {
  const code = currency(currencyCode);
  const observed = money(observedPrice, 'observedPrice');
  const reference = money(referencePrice, 'referencePrice');
  const tolerance = Number(nearPercent);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError('nearPercent must be non-negative');

  if (reference === 0) {
    return Object.freeze({
      status: 'unavailable',
      reason: 'reference_price_zero',
      stance: FATEDROP_MARKET_STANCE.mode,
      currencyCode: code,
      referenceKind: text(referenceKind) || 'fair_price',
      observedPrice: roundMoney(observed),
      referencePrice: 0,
      amountDifference: null,
      percentDifference: null,
      position: 'unknown',
    });
  }

  const amountDifference = observed - reference;
  const percentDifference = (amountDifference / reference) * 100;
  let position = 'at_reference';
  if (percentDifference < -tolerance) position = 'below_reference';
  else if (percentDifference > tolerance) position = 'above_reference';

  return Object.freeze({
    status: 'available',
    reason: null,
    stance: FATEDROP_MARKET_STANCE.mode,
    currencyCode: code,
    referenceKind: text(referenceKind) || 'fair_price',
    observedPrice: roundMoney(observed),
    referencePrice: roundMoney(reference),
    amountDifference: roundMoney(amountDifference),
    percentDifference: roundPercent(percentDifference),
    position,
  });
}
