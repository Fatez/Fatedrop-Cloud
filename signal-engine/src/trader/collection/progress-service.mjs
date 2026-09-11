import { listCollectionItemsFromStore } from './store.mjs';
import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { enrichCardsWithPrintingArtwork, enrichPrintingsWithArtwork } from '../catalogue/artwork-store.mjs';
import { getVerifiedCardSetFromStore, listVerifiedCardsFromStore, listVerifiedPrintingsFromStore } from '../catalogue/store.mjs';
import { getOwnedFatePrices, exactCardValuesFromFatePrices } from './collector-summary-service.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { listTrackedCollectionSetBindersFromStore } from './set-binder-store.mjs';
import { listSetCompletionAssertionsFromStore } from './set-completion.mjs';

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
    exactOwnedCount: null,
    userConfirmedCount: null,
    exactIdentityConfirmationNeededCount: null,
    totalCount: null,
    missingCount: null,
    completionPercent: null,
    missingCards: Object.freeze([]),
  });
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

  const [rawCanonicalCards, rawCanonicalPrintings] = await Promise.all([
    listVerifiedCardsFromStore(store, { setId: canonicalSetId, limit: 500 }),
    listVerifiedPrintingsFromStore(store, { setId: canonicalSetId, limit: 1000 }),
  ]);
  const [canonicalCards, canonicalPrintings] = await Promise.all([
    enrichCardsWithPrintingArtwork(store, rawCanonicalCards),
    enrichPrintingsWithArtwork(store, rawCanonicalPrintings),
  ]);
  const printingChecklist = canonicalPrintings.length ? canonicalPrintings : null;
  const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards, canonicalPrintings: printingChecklist });
  if (catalogue.status !== 'complete') {
    return unavailable({
      reason: catalogue.reason,
      setId: canonicalSetId,
      set,
      catalogue,
    });
  }

  const [collectionItems, completionAssertions] = await Promise.all([
    listCollectionItemsFromStore(store, { userId: ownerId, limit: 2000 }),
    listSetCompletionAssertionsFromStore(store, { userId: ownerId, setIds: [canonicalSetId] }),
  ]);
  const assertedPrintingIds = completionAssertions[0]?.printingIds ?? [];
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
    canonicalPrintings: printingChecklist,
    collectionItems,
    exactCardValues,
    printingValues,
    currencyCode: currency,
    preferredLanguageCode,
    preferredVariantCode,
    setCompletionAssertions: completionAssertions,
  });
  const tracked = await listTrackedCollectionSetBindersFromStore(store, { userId: ownerId });
  const progress = summary.sets[0];
  return Object.freeze({
    ...progress,
    catalogue,
    explicitlyTracked: tracked.some((binder) => binder.setId === canonicalSetId),
    hasUserCompletionAssertion: assertedPrintingIds.length > 0,
    priceEvidenceConnected: priceRead.connected,
  });
}
