import { listVerifiedCardsByIdsFromStore, listVerifiedCardsFromStore, listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';
import { buildChecklistPrintingValues } from '../value/checklist-prices.mjs';
import { loadFatePricesFromStore } from '../value/fate-price-service.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { selectPreferredPrintingRepresentative } from './set-progress.mjs';
import { listCollectionItemsFromStore } from './store.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function cardId(card) {
  return String(card?.fateCardId ?? card?.id ?? '').trim();
}

function checklistPriceCandidateIds(canonicalCards, {
  preferredLanguageCode,
  preferredVariantCode,
} = {}) {
  const language = requireText(preferredLanguageCode, 'preferredLanguageCode').toLowerCase();
  const variant = requireText(preferredVariantCode, 'preferredVariantCode').toLowerCase();
  const byPrinting = new Map();

  for (const card of canonicalCards) {
    if (!card || card.verificationStatus !== 'verified' || !card.printingId) continue;
    if (!byPrinting.has(card.printingId)) byPrinting.set(card.printingId, []);
    byPrinting.get(card.printingId).push(card);
  }

  const ids = [];
  for (const identities of byPrinting.values()) {
    const representative = selectPreferredPrintingRepresentative(identities, {
      preferredLanguageCode: language,
      preferredVariantCode: variant,
    });
    if (!representative) continue;
    if (String(representative.languageCode ?? '').trim().toLowerCase() !== language) continue;
    if (String(representative.variantCode ?? '').trim().toLowerCase() !== variant) continue;
    const id = cardId(representative);
    if (id) ids.push(id);
  }
  return ids;
}

function topLevelStatus({ collectionItems, unresolvedCollectionItemCount, summary, valuation }) {
  if (collectionItems.length === 0) return Object.freeze({ status: 'empty', reason: 'collection_empty' });
  if (unresolvedCollectionItemCount > 0) return Object.freeze({ status: 'partial', reason: 'collection_identity_unresolved' });
  if (summary.unavailableSetCount > 0) return Object.freeze({ status: 'partial', reason: 'canonical_checklist_incomplete' });
  if (valuation.status === 'building') return Object.freeze({ status: 'partial', reason: valuation.reason });
  const setPricingIncomplete = summary.sets.some((set) => set.status === 'available' && set.value?.status !== 'available');
  if (summary.collection.status !== 'available' || setPricingIncomplete || valuation.status !== 'available') {
    return Object.freeze({ status: 'partial', reason: 'market_price_coverage_incomplete' });
  }
  return Object.freeze({ status: 'available', reason: null });
}

export async function getFateCollectorSummaryFromStore(store, {
  userId,
  currencyCode,
  preferredLanguageCode,
  preferredVariantCode = 'standard',
  asOf = Date.now(),
} = {}) {
  const ownerId = requireText(userId, 'userId');
  const currency = requireText(currencyCode, 'currencyCode').toUpperCase();
  const language = requireText(preferredLanguageCode, 'preferredLanguageCode').toLowerCase();
  const variant = requireText(preferredVariantCode, 'preferredVariantCode').toLowerCase();
  const collectionItems = await listCollectionItemsFromStore(store, { userId: ownerId, limit: 2000 });
  const ownedCardIds = [...new Set(collectionItems.map((item) => item.fateCardId).filter(Boolean))];
  const ownedCards = await listVerifiedCardsByIdsFromStore(store, ownedCardIds, { limit: 2000 });
  const resolvedIds = new Set(ownedCards.map((card) => card.fateCardId));
  const ownedSetIds = new Set(ownedCards.map((card) => card.setId).filter(Boolean));
  const tcgCodes = new Set(ownedCards.map((card) => card.tcgCode).filter((code) => SUPPORTED_TCG_CODES.includes(code)));

  const sets = [];
  for (const tcgCode of tcgCodes) {
    const candidates = await listVerifiedCardSetsFromStore(store, { tcgCode, limit: 1000 });
    sets.push(...candidates.filter((set) => ownedSetIds.has(set.id)));
  }

  const canonicalCards = [];
  for (const set of sets) {
    canonicalCards.push(...await listVerifiedCardsFromStore(store, { setId: set.id, limit: 500 }));
  }

  const priceCandidateIds = [...new Set([
    ...ownedCards.map(cardId).filter(Boolean),
    ...checklistPriceCandidateIds(canonicalCards, {
      preferredLanguageCode: language,
      preferredVariantCode: variant,
    }),
  ])];
  const valuation = await loadFatePricesFromStore(store, {
    cardIdentityIds: priceCandidateIds,
    currencyCode: currency,
    asOf,
  });
  const availableFatePrices = valuation.prices.filter((price) => price.status === 'available');

  const printingValues = [];
  for (const set of sets) {
    const checklistPrices = buildChecklistPrintingValues({
      setId: set.id,
      canonicalCards,
      fatePrices: availableFatePrices,
      currencyCode: currency,
      preferredLanguageCode: language,
      preferredVariantCode: variant,
    });
    printingValues.push(...checklistPrices.printingValues);
  }

  const summary = computeFateCollectorSummary({
    sets,
    canonicalCards,
    collectionItems,
    exactCardValues: availableFatePrices,
    printingValues,
    currencyCode: currency,
    preferredLanguageCode: language,
    preferredVariantCode: variant,
  });
  const unresolvedCollectionItemCount = collectionItems.filter((item) => !resolvedIds.has(item.fateCardId)).length;
  const top = topLevelStatus({ collectionItems, unresolvedCollectionItemCount, summary, valuation });

  return Object.freeze({
    contractVersion: 1,
    status: top.status,
    reason: top.reason,
    summary,
    evidence: Object.freeze({
      collectionItemsRead: collectionItems.length,
      verifiedOwnedIdentities: ownedCards.length,
      unresolvedCollectionItemCount,
      completeSetValuesConnected: true,
      valuationStatus: valuation.status,
      valuationReason: valuation.reason,
      requestedPriceIdentityCount: valuation.requestedCardCount,
      resolvedPriceIdentityCount: valuation.availablePriceCount,
      unavailablePriceIdentityCount: valuation.unavailablePriceCount,
      rejectedPricingProvenanceCount: valuation.rejectedProvenanceCount,
      pricingEvidenceSourceType: valuation.evidenceSourceType,
    }),
  });
}
