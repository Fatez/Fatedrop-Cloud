import { listVerifiedCardsByIdsFromStore, listVerifiedCardsFromStore, listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';
import { buildChecklistPrintingValues } from '../value/checklist-prices.mjs';
import { loadFatePricesFromStore } from '../value/fate-price-service.mjs';
import { computeFateCollectorMovement } from './collector-movement.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { selectPreferredPrintingRepresentative } from './set-progress.mjs';
import { listCollectionItemsFromStore } from './store.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function requireTimestamp(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${field} must be a positive timestamp`);
  return number;
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

function buildPrintingValues({
  sets,
  canonicalCards,
  fatePrices,
  currencyCode,
  preferredLanguageCode,
  preferredVariantCode,
}) {
  const printingValues = [];
  for (const set of sets) {
    const checklistPrices = buildChecklistPrintingValues({
      setId: set.id,
      canonicalCards,
      fatePrices,
      currencyCode,
      preferredLanguageCode,
      preferredVariantCode,
    });
    printingValues.push(...checklistPrices.printingValues);
  }
  return printingValues;
}

async function buildValuationSnapshot({
  store,
  sets,
  canonicalCards,
  collectionItems,
  priceCandidateIds,
  currencyCode,
  preferredLanguageCode,
  preferredVariantCode,
  asOf,
}) {
  const valuation = await loadFatePricesFromStore(store, {
    cardIdentityIds: priceCandidateIds,
    currencyCode,
    asOf,
  });
  const availableFatePrices = valuation.prices.filter((price) => price.status === 'available');
  const printingValues = buildPrintingValues({
    sets,
    canonicalCards,
    fatePrices: availableFatePrices,
    currencyCode,
    preferredLanguageCode,
    preferredVariantCode,
  });
  const summary = computeFateCollectorSummary({
    sets,
    canonicalCards,
    collectionItems,
    exactCardValues: availableFatePrices,
    printingValues,
    currencyCode,
    preferredLanguageCode,
    preferredVariantCode,
  });
  return Object.freeze({ valuation, summary });
}

function hasCompleteCurrentValue(summary) {
  if (summary?.collection?.totalValue != null) return true;
  return (summary?.sets || []).some((set) => {
    const value = set?.value;
    return value?.fullSetValue != null || value?.ownedValue != null || value?.missingValue != null;
  });
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
  const currentAsOf = requireTimestamp(asOf, 'asOf');
  const sevenDayAsOf = currentAsOf - 7 * DAY_MS;
  const thirtyDayAsOf = currentAsOf - 30 * DAY_MS;

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

  const current = await buildValuationSnapshot({
    store,
    sets,
    canonicalCards,
    collectionItems,
    priceCandidateIds,
    currencyCode: currency,
    preferredLanguageCode: language,
    preferredVariantCode: variant,
    asOf: currentAsOf,
  });

  let sevenDay = null;
  let thirtyDay = null;
  if (priceCandidateIds.length > 0
      && current.valuation.status !== 'building'
      && hasCompleteCurrentValue(current.summary)) {
    sevenDay = await buildValuationSnapshot({
      store,
      sets,
      canonicalCards,
      collectionItems,
      priceCandidateIds,
      currencyCode: currency,
      preferredLanguageCode: language,
      preferredVariantCode: variant,
      asOf: sevenDayAsOf,
    });
    thirtyDay = await buildValuationSnapshot({
      store,
      sets,
      canonicalCards,
      collectionItems,
      priceCandidateIds,
      currencyCode: currency,
      preferredLanguageCode: language,
      preferredVariantCode: variant,
      asOf: thirtyDayAsOf,
    });
  }

  const movement = computeFateCollectorMovement({
    currentSummary: current.summary,
    sevenDaySummary: sevenDay?.summary ?? null,
    thirtyDaySummary: thirtyDay?.summary ?? null,
    currencyCode: currency,
    currentAsOf,
    sevenDayAsOf,
    thirtyDayAsOf,
  });
  const summary = Object.freeze({ ...current.summary, movement });
  const unresolvedCollectionItemCount = collectionItems.filter((item) => !resolvedIds.has(item.fateCardId)).length;
  const top = topLevelStatus({
    collectionItems,
    unresolvedCollectionItemCount,
    summary: current.summary,
    valuation: current.valuation,
  });

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
      valuationStatus: current.valuation.status,
      valuationReason: current.valuation.reason,
      requestedPriceIdentityCount: current.valuation.requestedCardCount,
      resolvedPriceIdentityCount: current.valuation.availablePriceCount,
      unavailablePriceIdentityCount: current.valuation.unavailablePriceCount,
      rejectedPricingProvenanceCount: current.valuation.rejectedProvenanceCount,
      pricingEvidenceSourceType: current.valuation.evidenceSourceType,
      movementBasis: movement.basis,
      sevenDayValuationStatus: sevenDay?.valuation.status ?? 'unavailable',
      sevenDayValuationReason: sevenDay?.valuation.reason ?? 'historical_baseline_not_loaded',
      thirtyDayValuationStatus: thirtyDay?.valuation.status ?? 'unavailable',
      thirtyDayValuationReason: thirtyDay?.valuation.reason ?? 'historical_baseline_not_loaded',
    }),
  });
}
