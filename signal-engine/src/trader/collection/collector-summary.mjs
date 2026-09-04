import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { computeFateCollectionValue } from '../value/collection-value.mjs';
import { toPublicKnownPrice } from '../value/market-reflection-policy.mjs';
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
    missingCards: Object.freeze([]),
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

function publicClosestSet(row) {
  return row ? Object.freeze({
    setId: row.setId,
    setName: row.setName,
    tcgCode: row.tcgCode,
    completionPercent: row.completionPercent,
    missingCount: row.missingCount,
  }) : null;
}

function cardContextById(canonicalCards) {
  return new Map(
    canonicalCards
      .filter((card) => card?.verificationStatus === 'verified')
      .map((card) => [text(card.fateCardId ?? card.id), Object.freeze({ tcgCode:text(card.tcgCode), setId:text(card.setId) })])
      .filter(([id, context]) => id && context.tcgCode && context.setId),
  );
}

function ownedSetIdsByTcg(canonicalCards, collectionItems) {
  const context = cardContextById(canonicalCards);
  const byTcg = new Map();
  for (const item of activeItems(collectionItems)) {
    const card = context.get(text(item.fateCardId));
    if (!card) continue;
    if (!byTcg.has(card.tcgCode)) byTcg.set(card.tcgCode, new Set());
    byTcg.get(card.tcgCode).add(card.setId);
  }
  return byTcg;
}

function printingPriceIndex(printingValues) {
  const index=new Map();
  for(const raw of printingValues){
    const printingId=text(raw?.printingId);
    const amount=Number(raw?.amount);
    if(!printingId||!Number.isFinite(amount)||amount<0)continue;
    const candidate=Object.freeze({
      status:'available',
      amount,
      currencyCode:text(raw.currencyCode).toUpperCase()||null,
      observedAt:raw.observedAt==null?null:Number(raw.observedAt),
      sourceEffectiveAt:raw.observedAt==null?null:Number(raw.observedAt),
    });
    const existing=index.get(printingId);
    const candidateAt=Number(candidate.observedAt??0);
    const existingAt=Number(existing?.observedAt??0);
    if(!existing||candidateAt>=existingAt)index.set(printingId,candidate);
  }
  return index;
}

function enrichMissingCards(missingCards, priceIndex) {
  return Object.freeze((missingCards||[]).map((card)=>{
    const price=priceIndex.get(text(card.printingId))??null;
    return Object.freeze({
      ...card,
      priceStatus:price?'available':'unavailable',
      knownPrice:toPublicKnownPrice(price),
    });
  }));
}

function buildGameSummaries({
  canonicalCards,
  collectionItems,
  exactCardValues,
  setSummaries,
  currencyCode,
}) {
  const context = cardContextById(canonicalCards);
  const ownedSetsByTcg = ownedSetIdsByTcg(canonicalCards, collectionItems);
  const tcgCodes = [...ownedSetsByTcg.keys()].sort();

  return Object.freeze(tcgCodes.map((tcgCode) => {
    const gameItems = activeItems(collectionItems).filter((item) => context.get(text(item.fateCardId))?.tcgCode === tcgCode);
    const gamePortfolio = computeFateCollectionValue({
      collectionItems:gameItems,
      cardValues:exactCardValues,
      currencyCode,
    });
    const gameSets = setSummaries.filter((set) => set.tcgCode === tcgCode);
    const unavailableSetCount = gameSets.filter((set) => set.status !== 'available').length;
    const progressAvailableSetCount = gameSets.filter((set) => set.status === 'available' && Number(set.ownedCount) > 0).length;
    const closest = closestSet(gameSets);

    return Object.freeze({
      tcgCode,
      collection:gamePortfolio,
      cardUnits:gamePortfolio.totalUnits,
      setsOwned:ownedSetsByTcg.get(tcgCode)?.size ?? 0,
      progressAvailableSetCount,
      unavailableSetCount,
      closestSet:publicClosestSet(closest),
      sets:Object.freeze(gameSets),
    });
  }));
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
  const priceIndex=printingPriceIndex(printingValues);

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
      missingCards: enrichMissingCards(progress.missingCards,priceIndex),
      value,
    });
  });

  const ownedSetsByTcg = ownedSetIdsByTcg(canonicalCards, collectionItems);
  const ownedSetIds = new Set([...ownedSetsByTcg.values()].flatMap((ids) => [...ids]));
  const unavailableSetCount = setSummaries.filter((row) => row.status !== 'available').length;
  const progressAvailableSetCount = setSummaries.filter((row) => row.status === 'available' && Number(row.ownedCount) > 0).length;
  const closest = closestSet(setSummaries);
  const games = buildGameSummaries({
    canonicalCards,
    collectionItems,
    exactCardValues,
    setSummaries,
    currencyCode,
  });

  return Object.freeze({
    currencyCode: portfolio.currencyCode,
    collection: portfolio,
    cardUnits: portfolio.totalUnits,
    setsOwned: ownedSetIds.size,
    progressAvailableSetCount,
    unavailableSetCount,
    closestSet: publicClosestSet(closest),
    games,
    sets: Object.freeze(setSummaries),
  });
}
