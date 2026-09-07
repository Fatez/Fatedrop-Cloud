import { listCollectionItemsFromStore } from './store.mjs';
import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { getVerifiedCardSetFromStore, listVerifiedCardsFromStore } from '../catalogue/store.mjs';
import { getOwnedFatePrices, exactCardValuesFromFatePrices } from './collector-summary-service.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { listTrackedCollectionSetBindersFromStore } from './set-binder-store.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function unavailable({ reason, setId, set = null, catalogue = null }) {
  return Object.freeze({
    status: 'unavailable',
    reason,
    tcgCode: set?.tcgCode ?? null,
    setId,
    setName: set?.name ?? null,
    catalogue,
    ownedCount: null,
    totalCount: null,
    missingCount: null,
    completionPercent: null,
    missingCards: Object.freeze([]),
    topMissingCards: Object.freeze([]),
  });
}

export function rankPricedMissingCards(missingCards, exactCardValues, { limit = 3 } = {}) {
  if (!Array.isArray(missingCards)) throw new TypeError('missingCards must be an array');
  if (!Array.isArray(exactCardValues)) throw new TypeError('exactCardValues must be an array');
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative integer');

  const valueByCardId = new Map(
    exactCardValues
      .filter((value) => value && typeof value.fateCardId === 'string' && Number.isFinite(Number(value.amount)))
      .map((value) => [value.fateCardId, value]),
  );

  return Object.freeze(
    missingCards
      .map((card) => {
        const value = valueByCardId.get(card?.fateCardId);
        if (!card || !value) return null;
        return Object.freeze({
          ...card,
          currentPrice: Number(value.amount),
          currencyCode: value.currencyCode ?? null,
          priceObservedAt: value.observedAt ?? null,
        });
      })
      .filter(Boolean)
      .sort((a, b) => (
        Number(b.currentPrice) - Number(a.currentPrice)
        || String(a.collectorNumber || '').localeCompare(String(b.collectorNumber || ''), undefined, { numeric: true })
        || String(a.name || '').localeCompare(String(b.name || ''))
        || String(a.fateCardId || '').localeCompare(String(b.fateCardId || ''))
      ))
      .slice(0, limit),
  );
}

export async function getCollectionSetProgressFromStore(store, {
  userId,
  setId,
  currencyCode = 'GBP',
  preferredLanguageCode = null,
  preferredVariantCode = 'standard',
  now = Date.now(),
  fxClient,
} = {}) {
  const ownerId = requireText(userId, 'userId');
  const canonicalSetId = requireText(setId, 'setId');
  const currency = requireText(currencyCode, 'currencyCode').toUpperCase();
  const set = await getVerifiedCardSetFromStore(store, canonicalSetId);
  if (!set) return unavailable({ reason:'verified_set_not_found', setId:canonicalSetId });

  const canonicalCards = await listVerifiedCardsFromStore(store, { setId: canonicalSetId, limit: 500 });
  const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards });
  if (catalogue.status !== 'complete') {
    return unavailable({
      reason: catalogue.reason,
      setId: canonicalSetId,
      set,
      catalogue,
    });
  }

  const collectionItems = await listCollectionItemsFromStore(store, { userId: ownerId, limit: 2000 });
  const valueCards = canonicalCards.filter((card) => (
    (!preferredLanguageCode || card.languageCode === preferredLanguageCode)
    && (!preferredVariantCode || card.variantCode === preferredVariantCode)
  ));
  const priceRead = await getOwnedFatePrices(store, valueCards.map((card) => card.fateCardId), {
    currencyCode: currency,
    now,
    fxClient,
  });
  const exactCardValues = exactCardValuesFromFatePrices(priceRead.prices);
  const cardById = new Map(valueCards.map((card) => [card.fateCardId, card]));
  const printingValues = exactCardValues.map((value) => ({
    printingId: cardById.get(value.fateCardId)?.printingId,
    amount: value.amount,
    currencyCode: value.currencyCode,
    observedAt: value.observedAt,
  })).filter((value) => value.printingId);
  const summary = computeFateCollectorSummary({
    sets: [set],
    canonicalCards,
    collectionItems,
    exactCardValues,
    printingValues,
    currencyCode: currency,
    preferredLanguageCode,
    preferredVariantCode,
  });
  const tracked = await listTrackedCollectionSetBindersFromStore(store, { userId: ownerId });
  const progress = summary.sets[0];
  const topMissingCards = rankPricedMissingCards(progress?.missingCards || [], exactCardValues, { limit: 3 });
  return Object.freeze({
    ...progress,
    topMissingCards,
    catalogue,
    explicitlyTracked: tracked.some((binder) => binder.setId === canonicalSetId),
    priceEvidenceConnected: priceRead.connected,
  });
}
