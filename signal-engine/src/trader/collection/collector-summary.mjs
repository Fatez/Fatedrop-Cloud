import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { computeFateCollectionValue } from '../value/collection-value.mjs';
import { computeFateGradedCollectionValue } from '../value/graded-collection-value.mjs';
import { computeFateSetValue } from '../value/set-value.mjs';
import { computeCollectionSetProgress } from './set-progress.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function activeItems(items) {
  return items.filter((item) => item && item.status !== 'removed' && Number(item.quantity ?? 1) > 0);
}

function rawItems(items) {
  return activeItems(items).filter((item) => String(item.copyState || 'raw').toLowerCase() === 'raw');
}

function gradedItems(items) {
  return activeItems(items).filter((item) => String(item.copyState || '').toLowerCase() === 'graded');
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
      rawItems(collectionItems)
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
  gradedCardValues = [],
  printingValues = [],
  currencyCode,
  preferredLanguageCode = null,
  preferredVariantCode = 'standard',
} = {}) {
  if (!Array.isArray(sets)) throw new TypeError('sets must be an array');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');

  const rawHoldings = rawItems(collectionItems);
  const gradedHoldings = gradedItems(collectionItems);
  const rawPortfolio = computeFateCollectionValue({
    collectionItems: rawHoldings,
    cardValues: exactCardValues,
    currencyCode,
  });
  const gradedPortfolio = computeFateGradedCollectionValue({
    collectionItems: gradedHoldings,
    gradedValues: gradedCardValues,
    currencyCode,
  });
  const totalUnits = rawPortfolio.totalUnits + gradedPortfolio.totalUnits;
  const pricedUnits = rawPortfolio.pricedUnits + gradedPortfolio.pricedUnits;
  const unpricedUnits = totalUnits - pricedUnits;
  const knownValue = Number((rawPortfolio.knownValue + gradedPortfolio.knownValue).toFixed(2));
  const priceCoveragePercent = totalUnits === 0 ? 100 : Number(((pricedUnits / totalUnits) * 100).toFixed(1));
  const portfolio = Object.freeze({
    status: unpricedUnits === 0 ? 'available' : pricedUnits > 0 ? 'partial' : 'unavailable',
    reason: unpricedUnits === 0 ? null : pricedUnits > 0 ? 'price_coverage_incomplete' : 'no_price_evidence',
    currencyCode: rawPortfolio.currencyCode,
    itemCount: rawPortfolio.itemCount + gradedPortfolio.itemCount,
    totalUnits,
    pricedUnits,
    unpricedUnits,
    priceCoveragePercent,
    priceCoverageBand: priceCoveragePercent === 100 ? 'complete' : priceCoveragePercent >= 90 ? 'high' : priceCoveragePercent >= 70 ? 'medium' : priceCoveragePercent > 0 ? 'low' : 'none',
    totalValue: unpricedUnits === 0 ? knownValue : null,
    knownValue,
    unpricedItems: Object.freeze([...rawPortfolio.unpricedItems, ...gradedPortfolio.unpricedItems]),
  });

  const setSummaries = sets.map((set) => {
    const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards });
    if (catalogue.status !== 'complete') return setSummaryUnavailable(set, catalogue);

    const progress = computeCollectionSetProgress({
      set,
      canonicalCards,
      collectionItems: rawHoldings,
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
    rawCollection: rawPortfolio,
    gradedCollection: gradedPortfolio,
    cardUnits: portfolio.totalUnits,
    rawCardUnits: rawPortfolio.totalUnits,
    gradedCardUnits: gradedPortfolio.totalUnits,
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
