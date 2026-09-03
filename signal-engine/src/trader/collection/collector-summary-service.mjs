import { listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';
import { buildChecklistPrintingValues } from '../value/checklist-prices.mjs';
import { loadFatePricesFromStore } from '../value/fate-price-service.mjs';
import { computeFateCollectorMovement } from './collector-movement.mjs';
import {
  readCollectorCollectionItemsFromStore,
  readCollectorVerifiedCardsByIdsFromStore,
  readCollectorVerifiedSetCardsFromStore,
} from './collector-read-store.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { selectPreferredPrintingRepresentative } from './set-progress.mjs';

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

function unavailableMovement(currencyCode, currentAsOf, sevenDayAsOf, thirtyDayAsOf, reason) {
  const window = (baselineAsOf) => Object.freeze({
    status:'unavailable',reason,baselineAsOf,
    collection:Object.freeze({
      status:'unavailable',reason,currencyCode,amountChange:null,percentChange:null,
      currentValue:null,baselineValue:null,currentAsOf,baselineAsOf,
    }),
    sets:Object.freeze([]),
  });
  return Object.freeze({
    schemaVersion:1,basis:'current-holdings-repriced',currencyCode,currentAsOf,
    sevenDay:window(sevenDayAsOf),
    thirtyDay:window(thirtyDayAsOf),
  });
}

function unavailableSummary({
  currencyCode,
  totalItems,
  totalUnits,
  reason,
  currentAsOf,
  sevenDayAsOf,
  thirtyDayAsOf,
  setsOwned=null,
}={}) {
  return Object.freeze({
    currencyCode,
    collection:Object.freeze({
      status:'unavailable',reason,currencyCode,
      itemCount:totalItems,
      totalUnits,
      pricedUnits:null,
      unpricedUnits:null,
      priceCoveragePercent:null,
      priceCoverageBand:'unknown',
      totalValue:null,
      knownValue:null,
      unpricedItems:Object.freeze([]),
    }),
    cardUnits:totalUnits,
    setsOwned,
    progressAvailableSetCount:0,
    unavailableSetCount:null,
    closestSet:null,
    games:Object.freeze([]),
    sets:Object.freeze([]),
    movement:unavailableMovement(currencyCode,currentAsOf,sevenDayAsOf,thirtyDayAsOf,reason),
  });
}

function truncatedResponse({
  reason,
  currencyCode,
  collectionRead,
  currentAsOf,
  sevenDayAsOf,
  thirtyDayAsOf,
  setsOwned=null,
  evidence={},
}) {
  return Object.freeze({
    contractVersion:1,
    status:'partial',
    reason,
    summary:unavailableSummary({
      currencyCode,
      totalItems:collectionRead.totalItems,
      totalUnits:collectionRead.totalUnits,
      reason,
      currentAsOf,
      sevenDayAsOf,
      thirtyDayAsOf,
      setsOwned,
    }),
    evidence:Object.freeze({
      collectionItemsRead:collectionRead.items.length,
      collectionItemsTotal:collectionRead.totalItems,
      collectionUnitsTotal:collectionRead.totalUnits,
      collectionReadTruncated:collectionRead.truncated,
      collectionReadCap:collectionRead.maxItems,
      completeSetValuesConnected:true,
      valuationStatus:'unavailable',
      valuationReason:reason,
      ...evidence,
    }),
  });
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

  const collectionRead = await readCollectorCollectionItemsFromStore(store,{userId:ownerId});
  if(collectionRead.truncated){
    return truncatedResponse({
      reason:'collection_read_truncated',currencyCode:currency,collectionRead,currentAsOf,sevenDayAsOf,thirtyDayAsOf,
    });
  }
  const collectionItems=collectionRead.items;
  const ownedCardIds=[...new Set(collectionItems.map((item)=>item.fateCardId).filter(Boolean))];
  const ownedCardRead=await readCollectorVerifiedCardsByIdsFromStore(store,ownedCardIds);
  if(ownedCardRead.truncated){
    return truncatedResponse({
      reason:'owned_card_identity_read_truncated',currencyCode:currency,collectionRead,currentAsOf,sevenDayAsOf,thirtyDayAsOf,
      evidence:{ownedCardIdentityReadCap:ownedCardRead.maxCards,ownedCardIdentityRequestedCount:ownedCardRead.requestedCount},
    });
  }
  const ownedCards=ownedCardRead.cards;
  const resolvedIds=new Set(ownedCards.map((card)=>card.fateCardId));
  const ownedSetIds=new Set(ownedCards.map((card)=>card.setId).filter(Boolean));
  const tcgCodes=new Set(ownedCards.map((card)=>card.tcgCode).filter((code)=>SUPPORTED_TCG_CODES.includes(code)));

  const sets=[];
  for(const tcgCode of tcgCodes){
    const candidates=await listVerifiedCardSetsFromStore(store,{tcgCode,limit:1000});
    sets.push(...candidates.filter((set)=>ownedSetIds.has(set.id)));
  }

  const canonicalCards=[];
  const setReads=[];
  for(const set of sets){
    const read=await readCollectorVerifiedSetCardsFromStore(store,{setId:set.id});
    setReads.push(Object.freeze({setId:set.id,totalCards:read.totalCards,truncated:read.truncated,maxCards:read.maxCards}));
    canonicalCards.push(...read.cards);
  }
  const truncatedSetRead=setReads.find((read)=>read.truncated);
  if(truncatedSetRead){
    return truncatedResponse({
      reason:'canonical_set_read_truncated',currencyCode:currency,collectionRead,currentAsOf,sevenDayAsOf,thirtyDayAsOf,
      setsOwned:ownedSetIds.size,
      evidence:{
        verifiedOwnedIdentities:ownedCards.length,
        unresolvedCollectionItemCount:collectionItems.filter((item)=>!resolvedIds.has(item.fateCardId)).length,
        canonicalSetIdentityReads:Object.freeze(setReads),
        truncatedSetId:truncatedSetRead.setId,
      },
    });
  }

  const priceCandidateIds=[...new Set([
    ...ownedCards.map(cardId).filter(Boolean),
    ...checklistPriceCandidateIds(canonicalCards,{preferredLanguageCode:language,preferredVariantCode:variant}),
  ])];

  const current=await buildValuationSnapshot({
    store,sets,canonicalCards,collectionItems,priceCandidateIds,currencyCode:currency,
    preferredLanguageCode:language,preferredVariantCode:variant,asOf:currentAsOf,
  });

  let sevenDay=null;
  let thirtyDay=null;
  if(priceCandidateIds.length>0&&current.valuation.status!=='building'&&hasCompleteCurrentValue(current.summary)){
    sevenDay=await buildValuationSnapshot({
      store,sets,canonicalCards,collectionItems,priceCandidateIds,currencyCode:currency,
      preferredLanguageCode:language,preferredVariantCode:variant,asOf:sevenDayAsOf,
    });
    thirtyDay=await buildValuationSnapshot({
      store,sets,canonicalCards,collectionItems,priceCandidateIds,currencyCode:currency,
      preferredLanguageCode:language,preferredVariantCode:variant,asOf:thirtyDayAsOf,
    });
  }

  const movement=computeFateCollectorMovement({
    currentSummary:current.summary,sevenDaySummary:sevenDay?.summary??null,thirtyDaySummary:thirtyDay?.summary??null,
    currencyCode:currency,currentAsOf,sevenDayAsOf,thirtyDayAsOf,
  });
  const summary=Object.freeze({...current.summary,movement});
  const unresolvedCollectionItemCount=collectionItems.filter((item)=>!resolvedIds.has(item.fateCardId)).length;
  const top=topLevelStatus({collectionItems,unresolvedCollectionItemCount,summary:current.summary,valuation:current.valuation});

  return Object.freeze({
    contractVersion:1,
    status:top.status,
    reason:top.reason,
    summary,
    evidence:Object.freeze({
      collectionItemsRead:collectionItems.length,
      collectionItemsTotal:collectionRead.totalItems,
      collectionUnitsTotal:collectionRead.totalUnits,
      collectionReadTruncated:false,
      collectionReadCap:collectionRead.maxItems,
      verifiedOwnedIdentities:ownedCards.length,
      unresolvedCollectionItemCount,
      canonicalSetIdentityReads:Object.freeze(setReads),
      completeSetValuesConnected:true,
      valuationStatus:current.valuation.status,
      valuationReason:current.valuation.reason,
      requestedPriceIdentityCount:current.valuation.requestedCardCount,
      resolvedPriceIdentityCount:current.valuation.availablePriceCount,
      unavailablePriceIdentityCount:current.valuation.unavailablePriceCount,
      rejectedPricingProvenanceCount:current.valuation.rejectedProvenanceCount,
      pricingEvidenceSourceType:current.valuation.evidenceSourceType,
      movementBasis:movement.basis,
      sevenDayValuationStatus:sevenDay?.valuation.status??'unavailable',
      sevenDayValuationReason:sevenDay?.valuation.reason??'historical_baseline_not_loaded',
      thirtyDayValuationStatus:thirtyDay?.valuation.status??'unavailable',
      thirtyDayValuationReason:thirtyDay?.valuation.reason??'historical_baseline_not_loaded',
    }),
  });
}
