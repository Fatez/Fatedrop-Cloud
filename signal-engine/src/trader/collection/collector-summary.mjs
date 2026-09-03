import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { computeFateCollectionValue } from '../value/collection-value.mjs';
import { computeFateSetValue } from '../value/set-value.mjs';
import { computeCollectionSetProgress } from './set-progress.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function activeItems(items) {
  return items.filter((item) => item && item.status !== 'removed' && Number(item.quantity ?? 1) > 0);
}

function ownedPrintingIdsForSet(setId, canonicalCards, collectionItems) {
  const cardToPrinting = new Map(
    canonicalCards
      .filter((card) => card?.verificationStatus === 'verified' && text(card.setId) === setId)
      .map((card) => [text(card.fateCardId ?? card.id), text(card.printingId)])
      .filter(([cardId, printingId]) => cardId && printingId),
  );

  return Object.freeze([
    ...new Set(
      activeItems(collectionItems)
        .map((item) => cardToPrinting.get(text(item.fateCardId)))
        .filter(Boolean),
    ),
  ]);
}

function setSummaryUnavailable(set, catalogue) {
  return Object.freeze({
    setId: set.id,
    setName: set.name ?? null,
    tcgCode: set.tcgCode ?? null,
    status: 'unavailable',
    reason: catalogue.reason,
    catalogue,
    ownedCount: null,
    totalCount: null,
    missingCount: null,
    completionPercent: null,
    value: null,
  });
}

function closestSet(summaries) {
  const owned = summaries.filter((row) => row.status === 'available' && Number(row.ownedCount) > 0);
  if (!owned.length) return null;
  const incomplete = owned.filter((row) => Number(row.missingCount) > 0);
  const candidates = incomplete.length ? incomplete : owned;
  return [...candidates].sort((a, b) =>
    Number(b.completionPercent) - Number(a.completionPercent)
    || Number(a.missingCount) - Number(b.missingCount)
    || String(a.setName || '').localeCompare(String(b.setName || ''))
  )[0] ?? null;
}

export function computeFateCollectorSummary({
  sets,
  canonicalCards,
  collectionItems,
  exactCardValues = [],
  printingValues = [],
  currencyCode,
  preferredLanguageCode = null,
  preferredVariantCode = 'standard',
} = {}) {
  if (!Array.isArray(sets)) throw new TypeError('sets must be an array');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');

  const portfolio = computeFateCollectionValue({
    collectionItems,
    cardValues: exactCardValues,
    currencyCode,
  });

  const setSummaries = sets.map((set) => {
    const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards });
    if (catalogue.status !== 'complete') return setSummaryUnavailable(set, catalogue);

    const progress = computeCollectionSetProgress({
      set,
      canonicalCards,
      collectionItems,
      preferredLanguageCode,
      preferredVariantCode,
    });
    const ownedPrintingIds = ownedPrintingIdsForSet(set.id, canonicalCards, collectionItems);
    const value = computeFateSetValue({
      set,
      canonicalCards,
      printingValues,
      ownedPrintingIds,
      currencyCode,
    });

    return Object.freeze({
      setId: set.id,
      setName: set.name ?? null,
      tcgCode: set.tcgCode ?? null,
      status: progress.status,
      reason: progress.reason,
      catalogue,
      ownedCount: progress.ownedCount,
      totalCount: progress.totalCount,
      missingCount: progress.missingCount,
      completionPercent: progress.completionPercent,
      missingCards: progress.missingCards,
      value,
    });
  });

  const ownedSets = setSummaries.filter((row) => row.status === 'available' && Number(row.ownedCount) > 0);
  const unavailableSetCount = setSummaries.filter((row) => row.status !== 'available').length;
  const closest = closestSet(setSummaries);

  return Object.freeze({
    currencyCode: portfolio.currencyCode,
    collection: portfolio,
    cardUnits: portfolio.totalUnits,
    setsOwned: ownedSets.length,
    unavailableSetCount,
    closestSet: closest ? Object.freeze({
      setId: closest.setId,
      setName: closest.setName,
      tcgCode: closest.tcgCode,
      completionPercent: closest.completionPercent,
      missingCount: closest.missingCount,
    }) : null,
    sets: Object.freeze(setSummaries),
  });
}
