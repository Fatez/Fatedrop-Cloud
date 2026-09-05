import { listVerifiedCardsByIdsFromStore, listVerifiedCardsFromStore, listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';
import { computeFateCollectorSummary } from './collector-summary.mjs';
import { getFateCollectorPersonalPulseFromStore } from './personal-pulse-service.mjs';
import { listCollectionItemsFromStore } from './store.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

export async function getFateCollectorSummaryFromStore(store, {
  userId,
  currencyCode,
  preferredLanguageCode,
  preferredVariantCode = 'standard',
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

  const [summary,personalPulse]=await Promise.all([
    Promise.resolve(computeFateCollectorSummary({
      sets,
      canonicalCards,
      collectionItems,
      exactCardValues:[],
      printingValues:[],
      currencyCode:currency,
      preferredLanguageCode:language,
      preferredVariantCode,
    })),
    getFateCollectorPersonalPulseFromStore(store,{userId:ownerId,currencyCode:currency,limit:3}),
  ]);
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
      completeSetValuesConnected:false,
      valuationReason:'market_price_runtime_not_connected',
      personalPulseConnected:true,
    }),
  });
}
