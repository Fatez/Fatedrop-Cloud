import { calculateFatePrice } from './fate-price.mjs';
import { listFatePriceObservationsFromStore } from './fate-price-store.mjs';

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
