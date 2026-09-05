import { defaultEcbFxClient, FxRateUnavailableError } from './ecb-fx.mjs';

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function roundMoney(value) {
  return value == null ? null : Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function convertMoney(value, rate) {
  return value == null ? null : roundMoney(Number(value) * rate);
}

function fxFailure(error) {
  return Object.freeze({
    available: false,
    reason: error instanceof FxRateUnavailableError ? error.code : 'FX_RATE_UNAVAILABLE',
    message: error?.message || String(error),
  });
}

function identityFx(currencyCode, at) {
  const day = new Date(Number(at)).toISOString().slice(0, 10);
  return Object.freeze({
    available: true,
    sourceName: 'identity',
    sourceUrl: null,
    baseCurrencyCode: currencyCode,
    quoteCurrencyCode: currencyCode,
    rate: 1,
    rateDate: day,
    requestedDay: day,
  });
}

async function resolveFx(fxClient, fromCurrencyCode, toCurrencyCode, at) {
  const from = upper(fromCurrencyCode);
  const to = upper(toCurrencyCode);
  if (from === to) return identityFx(from, at);
  const rate = await fxClient.getRate({ fromCurrencyCode: from, toCurrencyCode: to, at });
  return Object.freeze({ available: true, ...rate });
}

function convertedPrice(sourcePrice, displayCurrencyCode, fx) {
  return Object.freeze({
    amount: convertMoney(sourcePrice.amount, fx.rate),
    currencyCode: displayCurrencyCode,
    fairLow: convertMoney(sourcePrice.fairLow, fx.rate),
    fairHigh: convertMoney(sourcePrice.fairHigh, fx.rate),
    guideLow: convertMoney(sourcePrice.guideLow, fx.rate),
    asOf: sourcePrice.asOf,
  });
}

export async function presentFatePrice(fatePrice, {
  displayCurrencyCode = 'GBP',
  fxClient = defaultEcbFxClient,
} = {}) {
  const displayCurrency = upper(displayCurrencyCode);
  if (!displayCurrency) throw new TypeError('displayCurrencyCode is required');
  if (!fatePrice?.available || !fatePrice.price) {
    return Object.freeze({
      ...fatePrice,
      displayCurrencyCode: displayCurrency,
      sourcePrice: fatePrice?.price ?? null,
      fx: null,
    });
  }

  const sourcePrice = fatePrice.price;
  try {
    const fx = await resolveFx(fxClient, sourcePrice.currencyCode, displayCurrency, sourcePrice.asOf);
    return Object.freeze({
      ...fatePrice,
      displayCurrencyCode: displayCurrency,
      sourcePrice,
      price: convertedPrice(sourcePrice, displayCurrency, fx),
      movementCurrencyCode: fatePrice.marketScope?.currencyCode ?? sourcePrice.currencyCode,
      fx,
    });
  } catch (error) {
    return Object.freeze({
      ...fatePrice,
      available: false,
      reason: error instanceof FxRateUnavailableError ? error.code : 'FX_RATE_UNAVAILABLE',
      displayCurrencyCode: displayCurrency,
      sourcePrice,
      price: null,
      movementCurrencyCode: fatePrice.marketScope?.currencyCode ?? sourcePrice.currencyCode,
      fx: fxFailure(error),
    });
  }
}

export async function presentFatePrices(fatePrices, options = {}) {
  if (!Array.isArray(fatePrices)) throw new TypeError('fatePrices must be an array');
  return Object.freeze(await Promise.all(fatePrices.map((fatePrice) => presentFatePrice(fatePrice, options))));
}

export async function presentFatePriceHistory(history, {
  displayCurrencyCode = 'GBP',
  fxClient = defaultEcbFxClient,
} = {}) {
  const displayCurrency = upper(displayCurrencyCode);
  if (!displayCurrency) throw new TypeError('displayCurrencyCode is required');
  const sourcePoints = Object.freeze([...(history?.points ?? [])]);
  if (!history?.available || !sourcePoints.length) {
    return Object.freeze({
      ...history,
      displayCurrencyCode: displayCurrency,
      sourcePoints,
      fx: Object.freeze([]),
    });
  }

  const converted = [];
  const fxEvidence = [];
  try {
    for (const point of sourcePoints) {
      const fx = await resolveFx(fxClient, point.currencyCode, displayCurrency, point.asOf);
      fxEvidence.push(Object.freeze({ marketDay: point.marketDay, ...fx }));
      converted.push(Object.freeze({
        ...point,
        amount: convertMoney(point.amount, fx.rate),
        currencyCode: displayCurrency,
        fairLow: convertMoney(point.fairLow, fx.rate),
        fairHigh: convertMoney(point.fairHigh, fx.rate),
        guideLow: convertMoney(point.guideLow, fx.rate),
      }));
    }
    return Object.freeze({
      ...history,
      displayCurrencyCode: displayCurrency,
      sourcePoints,
      points: Object.freeze(converted),
      fx: Object.freeze(fxEvidence),
    });
  } catch (error) {
    return Object.freeze({
      ...history,
      available: false,
      reason: error instanceof FxRateUnavailableError ? error.code : 'FX_RATE_UNAVAILABLE',
      displayCurrencyCode: displayCurrency,
      sourcePoints,
      points: Object.freeze([]),
      fx: fxFailure(error),
    });
  }
}
