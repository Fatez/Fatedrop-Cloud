import { calculateFatePrice, calculateFatePriceHistory } from './fate-price.mjs';
import { listFatePriceObservationsFromStore } from './fate-price-store.mjs';
import { presentFatePrice, presentFatePriceHistory, presentFatePrices } from './fate-price-presentation.mjs';

function groupByCard(observations) {
  const grouped = new Map();
  for (const observation of observations) {
    const rows = grouped.get(observation.cardIdentityId) ?? [];
    rows.push(observation);
    grouped.set(observation.cardIdentityId, rows);
  }
  return grouped;
}

export async function getFatePriceFromStore(store, {
  cardIdentityId,
  currencyCode = null,
  marketSegmentKey = null,
  conditionCode = null,
  now = Date.now(),
} = {}) {
  const [result] = await getFatePricesFromStore(store, {
    cardIdentityIds: [cardIdentityId],
    currencyCode,
    marketSegmentKey,
    conditionCode,
    now,
  });
  return result;
}

export async function getFatePricesFromStore(store, {
  cardIdentityIds,
  currencyCode = null,
  marketSegmentKey = null,
  conditionCode = null,
  now = Date.now(),
} = {}) {
  if (!Array.isArray(cardIdentityIds) || !cardIdentityIds.length) {
    throw new TypeError('cardIdentityIds are required');
  }
  const ids = [...new Set(cardIdentityIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) throw new TypeError('cardIdentityIds are required');
  if (ids.length > 100) throw new TypeError('Fate Price supports at most 100 card identities per request');

  const observations = await listFatePriceObservationsFromStore(store, { cardIdentityIds: ids });
  const grouped = groupByCard(observations);
  return Object.freeze(ids.map((cardIdentityId) => calculateFatePrice(grouped.get(cardIdentityId) ?? [], {
    cardIdentityId,
    currencyCode,
    marketSegmentKey,
    conditionCode,
    now,
  })));
}

export async function getFatePriceHistoryFromStore(store, {
  cardIdentityId,
  currencyCode = null,
  marketSegmentKey = null,
  conditionCode = null,
  days = 30,
  now = Date.now(),
} = {}) {
  const id = String(cardIdentityId || '').trim();
  if (!id) throw new TypeError('cardIdentityId is required');
  if (![7, 30, 90].includes(days)) throw new TypeError('Fate Price history days must be 7, 30, or 90');
  const observations = await listFatePriceObservationsFromStore(store, {
    cardIdentityIds: [id],
    observationsPerCard: 500,
  });
  return calculateFatePriceHistory(observations, {
    cardIdentityId: id,
    currencyCode,
    marketSegmentKey,
    conditionCode,
    days,
    now,
  });
}

export async function getPresentedFatePriceFromStore(store, {
  displayCurrencyCode = 'GBP',
  fxClient,
  ...options
} = {}) {
  const fatePrice = await getFatePriceFromStore(store, options);
  return presentFatePrice(fatePrice, { displayCurrencyCode, fxClient });
}

export async function getPresentedFatePricesFromStore(store, {
  displayCurrencyCode = 'GBP',
  fxClient,
  ...options
} = {}) {
  const fatePrices = await getFatePricesFromStore(store, options);
  return presentFatePrices(fatePrices, { displayCurrencyCode, fxClient });
}

export async function getPresentedFatePriceHistoryFromStore(store, {
  displayCurrencyCode = 'GBP',
  fxClient,
  ...options
} = {}) {
  const history = await getFatePriceHistoryFromStore(store, options);
  return presentFatePriceHistory(history, { displayCurrencyCode, fxClient });
}
