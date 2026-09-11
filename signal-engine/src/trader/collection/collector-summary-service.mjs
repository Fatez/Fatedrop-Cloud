import { listVerifiedCardsByIdsFromStore, listVerifiedCardsFromStore, listVerifiedCardSetsByIdsFromStore, listVerifiedPrintingsFromStore } from '../catalogue/store.mjs';
import { FatePriceStoreUnavailableError } from '../value/fate-price-store.mjs';
import { getFatePricesFromStore, getPresentedFatePricesFromStore } from '../value/fate-price-service.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { buildFateCollectorPersonalPulse } from './personal-pulse.mjs';
import { listTrackedCollectionSetBindersFromStore } from './set-binder-store.mjs';
import { listSetCompletionAssertionsFromStore } from './set-completion.mjs';
import { listCollectionItemsFromStore } from './store.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

export async function getOwnedFatePrices(store, cardIdentityIds, { currencyCode, now, fxClient }) {
  const prices = [];
  try {
    for (let index = 0; index < cardIdentityIds.length; index += 100) {
      const batch = cardIdentityIds.slice(index, index + 100);
      if (!batch.length) continue;
      if (currencyCode === 'GBP') {
        prices.push(...await getPresentedFatePricesFromStore(store, {
          cardIdentityIds: batch,
          currencyCode: 'EUR',
          displayCurrencyCode: 'GBP',
          fxClient,
          now,
        }));
      } else {
        prices.push(...await getFatePricesFromStore(store, {
          cardIdentityIds: batch,
          currencyCode,
          now,
        }));
      }
    }
  } catch (error) {
    if (error instanceof FatePriceStoreUnavailableError) return Object.freeze({ connected: false, prices: Object.freeze([]) });
    throw error;
  }
  return Object.freeze({ connected: true, prices: Object.freeze(prices) });
}

export function exactCardValuesFromFatePrices(fatePrices) {
  return fatePrices
    .filter((fatePrice) => fatePrice?.available === true && fatePrice.price)
    .map((fatePrice) => Object.freeze({
      fateCardId: fatePrice.cardIdentityId,
      amount: fatePrice.price.amount,
      currencyCode: fatePrice.price.currencyCode,
      observedAt: fatePrice.price.asOf,
      valuationKind: 'raw-market',
      sourceName: fatePrice.evidence?.sources?.length === 1 ? fatePrice.evidence.sources[0] : 'fateprice',
      evidenceCount: fatePrice.evidence?.sourceCount ?? null,
    }));
}

export async function getFateCollectorSummaryFromStore(store, {
  userId,
  currencyCode,
  preferredLanguageCode,
  preferredVariantCode = 'standard',
  now = Date.now(),
  fxClient,
} = {}) {
  const ownerId=requireText(userId,'userId');
  const currency=requireText(currencyCode,'currencyCode').toUpperCase();
  const language=requireText(preferredLanguageCode,'preferredLanguageCode').toLowerCase();
  const collectionItems=await listCollectionItemsFromStore(store,{userId:ownerId,limit:2000});
  const ownedCardIds=[...new Set(collectionItems.map((item)=>item.fateCardId).filter(Boolean))];
  const ownedCards=await listVerifiedCardsByIdsFromStore(store,ownedCardIds,{limit:2000});
  const resolvedIds=new Set(ownedCards.map((card)=>card.fateCardId));
  const rawOwnedCardIds=new Set(collectionItems
    .filter((item)=>item?.status!=='removed'&&String(item?.copyState||'raw').toLowerCase()==='raw')
    .map((item)=>item.fateCardId)
    .filter(Boolean));
  const ownedSetIds=new Set(ownedCards.filter((card)=>rawOwnedCardIds.has(card.fateCardId)).map((card)=>card.setId).filter(Boolean));
  const [trackedBinders,completionAssertions]=await Promise.all([
    listTrackedCollectionSetBindersFromStore(store,{userId:ownerId}),
    listSetCompletionAssertionsFromStore(store,{userId:ownerId}),
  ]);
  const explicitlyTrackedSetIds=new Set(trackedBinders.map((binder)=>binder.setId));
  const userConfirmedSetIds=new Set(completionAssertions.map((assertion)=>assertion.setId));
  const binderSetIds=[...new Set([...ownedSetIds,...explicitlyTrackedSetIds,...userConfirmedSetIds])];
  const sets=await listVerifiedCardSetsByIdsFromStore(store,binderSetIds,{limit:2000});
  const canonicalCards=[];
  const canonicalPrintings=[];
  for(const set of sets){
    const [cards,printings]=await Promise.all([
      listVerifiedCardsFromStore(store,{setId:set.id,limit:500}),
      listVerifiedPrintingsFromStore(store,{setId:set.id,limit:1000}),
    ]);
    canonicalCards.push(...cards);
    canonicalPrintings.push(...printings);
  }

  const fatePriceRead = await getOwnedFatePrices(store, ownedCards.map((card) => card.fateCardId), {
    currencyCode: currency,
    now,
    fxClient,
  });
  const fatePrices = fatePriceRead.prices;
  const exactCardValues = exactCardValuesFromFatePrices(fatePrices);
  const computedSummary=computeFateCollectorSummary({
    sets,
    canonicalCards,
    canonicalPrintings,
    collectionItems,
    exactCardValues,
    gradedCardValues:[],
    printingValues:[],
    setCompletionAssertions:completionAssertions,
    currencyCode:currency,
    preferredLanguageCode:language,
    preferredVariantCode,
  });
  const summary=Object.freeze({
    ...computedSummary,
    bindersTracked:computedSummary.sets.length,
    sets:Object.freeze(computedSummary.sets.map((set)=>Object.freeze({
      ...set,
      explicitlyTracked:explicitlyTrackedSetIds.has(set.setId),
    }))),
  });
  const personalPulse=buildFateCollectorPersonalPulse({
    collectionItems:collectionItems.filter((item)=>String(item.copyState||'raw').toLowerCase()==='raw'),
    cards:ownedCards,
    prices:fatePrices,
    limit:3,
  });
  const unresolvedCollectionItemCount=collectionItems.filter((item)=>!resolvedIds.has(item.fateCardId)).length;
  const exactIdentityConfirmationNeededCount=summary.sets.reduce((sum,set)=>sum+Number(set.exactIdentityConfirmationNeededCount||0),0);
  const hasCollectionEvidence=collectionItems.length>0||completionAssertions.length>0;
  return Object.freeze({
    contractVersion:2,
    status:!hasCollectionEvidence?'empty':unresolvedCollectionItemCount||summary.unavailableSetCount||exactIdentityConfirmationNeededCount?'partial':'available',
    reason:!hasCollectionEvidence?'collection_empty':unresolvedCollectionItemCount?'collection_identity_unresolved':summary.unavailableSetCount?'canonical_checklist_incomplete':exactIdentityConfirmationNeededCount?'exact_identity_confirmation_needed':null,
    summary,
    personalPulse,
    evidence:Object.freeze({
      collectionItemsRead:collectionItems.length,
      verifiedOwnedIdentities:ownedCards.length,
      userConfirmedSetAssertions:completionAssertions.length,
      exactIdentityConfirmationNeededCount,
      unresolvedCollectionItemCount,
      exactCollectionValuesConnected:fatePriceRead.connected,
      gradedCollectionValuesConnected:false,
      completeSetValuesConnected:false,
      valuationReason:fatePriceRead.connected?summary.collection.reason:'market_price_runtime_unavailable',
      personalPulseConnected:fatePriceRead.connected,
      binderOwnershipPolicy:'raw_exact_or_user_confirmed_printing',
      binderTrackingPolicy:'explicit_or_raw_owned_set',
      assertedPrintingValuationPolicy:'excluded_until_exact_identity_confirmed',
      personalMovementPolicy:'raw_only',
      valuationCurrencyCode:currency,
      sourceMarketCurrencyCode:currency==='GBP'?'EUR':currency,
    }),
  });
}
