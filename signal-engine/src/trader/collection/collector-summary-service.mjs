import { listVerifiedCardsByIdsFromStore, listVerifiedCardsFromStore, listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';
import { FatePriceStoreUnavailableError } from '../value/fate-price-store.mjs';
import { getFatePricesFromStore } from '../value/fate-price-service.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { buildFateCollectorPersonalPulse } from './personal-pulse.mjs';
import { listCollectionItemsFromStore } from './store.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

async function getOwnedFatePrices(store, cardIdentityIds, { currencyCode, now }) {
  const prices = [];
  try {
    for (let index = 0; index < cardIdentityIds.length; index += 100) {
      const batch = cardIdentityIds.slice(index, index + 100);
      if (!batch.length) continue;
      prices.push(...await getFatePricesFromStore(store, {
        cardIdentityIds: batch,
        currencyCode,
        now,
      }));
    }
  } catch (error) {
    if (error instanceof FatePriceStoreUnavailableError) return Object.freeze({ connected: false, prices: Object.freeze([]) });
    throw error;
  }
  return Object.freeze({ connected: true, prices: Object.freeze(prices) });
}

function exactCardValuesFromFatePrices(fatePrices) {
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
} = {}) {
  const ownerId=requireText(userId,'userId');
  const currency=requireText(currencyCode,'currencyCode').toUpperCase();
  const language=requireText(preferredLanguageCode,'preferredLanguageCode').toLowerCase();
  const collectionItems=await listCollectionItemsFromStore(store,{userId:ownerId,limit:2000});
  const ownedCardIds=[...new Set(collectionItems.map((item)=>item.fateCardId).filter(Boolean))];
  const ownedCards=await listVerifiedCardsByIdsFromStore(store,ownedCardIds,{limit:2000});
  const resolvedIds=new Set(ownedCards.map((card)=>card.fateCardId));
  const ownedSetIds=new Set(ownedCards.map((card)=>card.setId).filter(Boolean));
  const tcgCodes=new Set(ownedCards.map((card)=>card.tcgCode).filter((code)=>SUPPORTED_TCG_CODES.includes(code)));
  const sets=[];
  for(const tcgCode of tcgCodes){
    const candidates=await listVerifiedCardSetsFromStore(store,{tcgCode,limit:1000});
    sets.push(...candidates.filter((set)=>ownedSetIds.has(set.id)));
  }
  const canonicalCards=[];
  for(const set of sets){
    canonicalCards.push(...await listVerifiedCardsFromStore(store,{setId:set.id,limit:500}));
  }

  const fatePriceRead = await getOwnedFatePrices(store, ownedCards.map((card) => card.fateCardId), {
    currencyCode: currency,
    now,
  });
  const fatePrices = fatePriceRead.prices;
  const exactCardValues = exactCardValuesFromFatePrices(fatePrices);
  const summary=computeFateCollectorSummary({
    sets,
    canonicalCards,
    collectionItems,
    exactCardValues,
    printingValues:[],
    currencyCode:currency,
    preferredLanguageCode:language,
    preferredVariantCode,
  });
  const personalPulse=buildFateCollectorPersonalPulse({
    collectionItems,
    cards:ownedCards,
    prices:fatePrices,
    limit:3,
  });
  const unresolvedCollectionItemCount=collectionItems.filter((item)=>!resolvedIds.has(item.fateCardId)).length;
  return Object.freeze({
    contractVersion:2,
    status:collectionItems.length===0?'empty':unresolvedCollectionItemCount||summary.unavailableSetCount?'partial':'available',
    reason:collectionItems.length===0?'collection_empty':unresolvedCollectionItemCount?'collection_identity_unresolved':summary.unavailableSetCount?'canonical_checklist_incomplete':null,
    summary,
    personalPulse,
    evidence:Object.freeze({
      collectionItemsRead:collectionItems.length,
      verifiedOwnedIdentities:ownedCards.length,
      unresolvedCollectionItemCount,
      exactCollectionValuesConnected:fatePriceRead.connected,
      completeSetValuesConnected:false,
      valuationReason:fatePriceRead.connected?summary.collection.reason:'market_price_runtime_unavailable',
      personalPulseConnected:fatePriceRead.connected,
    }),
  });
}
