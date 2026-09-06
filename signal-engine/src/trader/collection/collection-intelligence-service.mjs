import { listVerifiedCardsByIdsFromStore } from '../catalogue/store.mjs';
import { FatePriceStoreUnavailableError } from '../value/fate-price-store.mjs';
import { getPresentedFatePriceHistoriesFromStore } from '../value/fate-price-service.mjs';
import { buildFateCollectorIntelligence } from './collection-intelligence.mjs';
import { getOwnedFatePrices } from './collector-summary-service.mjs';
import { listCollectionItemsFromStore } from './store.mjs';

const HISTORY_IDENTITY_LIMIT = 100;

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

export async function getFateCollectorIntelligenceFromStore(store, {
  userId,
  currencyCode,
  now = Date.now(),
  fxClient,
} = {}) {
  const ownerId = requireText(userId, 'userId');
  const currency = requireText(currencyCode, 'currencyCode').toUpperCase();
  const collectionItems = await listCollectionItemsFromStore(store, { userId: ownerId, limit: 2000 });
  const rawCardIds = [...new Set(collectionItems
    .filter((item) => item?.status !== 'removed' && String(item?.copyState || 'raw').toLowerCase() === 'raw')
    .map((item) => item?.fateCardId)
    .filter(Boolean))];
  const cards = await listVerifiedCardsByIdsFromStore(store, rawCardIds, { limit: 2000 });
  const priceRead = await getOwnedFatePrices(store, rawCardIds, { currencyCode: currency, now, fxClient });
  const draft = buildFateCollectorIntelligence({
    collectionItems,
    cards,
    prices: priceRead.prices,
    currencyCode: currency,
  });
  const historyIds = draft.cards
    .filter((holding) => holding.currentUnitPrice != null)
    .slice(0, HISTORY_IDENTITY_LIMIT)
    .map((holding) => holding.cardIdentityId);
  let histories = [];
  let historyConnected = true;
  if (historyIds.length) {
    try {
      histories = await getPresentedFatePriceHistoriesFromStore(store, {
        cardIdentityIds: historyIds,
        currencyCode: currency === 'GBP' ? 'EUR' : currency,
        displayCurrencyCode: currency,
        days: 30,
        observationsPerCard: 120,
        now,
        fxClient,
      });
    } catch (error) {
      if (!(error instanceof FatePriceStoreUnavailableError)) throw error;
      historyConnected = false;
    }
  }
  const intelligence = buildFateCollectorIntelligence({
    collectionItems,
    cards,
    prices: priceRead.prices,
    histories,
    currencyCode: currency,
  });
  return Object.freeze({
    contractVersion: 1,
    ...intelligence,
    evidence: Object.freeze({
      ...intelligence.evidence,
      exactPriceRuntimeConnected: priceRead.connected,
      historyRuntimeConnected: historyConnected,
      historyIdentityLimit: HISTORY_IDENTITY_LIMIT,
      historyIncludedIdentities: historyIds.length,
    }),
  });
}
