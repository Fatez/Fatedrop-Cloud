import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';
import {
  readCollectorCollectionItemsFromStore,
  readCollectorVerifiedSetCardsFromStore,
} from './collector-read-store.mjs';
import { computeCollectionSetProgress } from './set-progress.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

async function getVerifiedSet(store, setId) {
  const id = requireText(setId, 'setId');
  for (const tcgCode of SUPPORTED_TCG_CODES) {
    const sets = await listVerifiedCardSetsFromStore(store, { tcgCode, limit: 1000 });
    const match = sets.find((set) => set.id === id);
    if (match) return match;
  }
  return null;
}

function unavailable({ reason, setId, set = null, catalogue = null, read = null }) {
  return Object.freeze({
    status: 'unavailable',
    reason,
    tcgCode: set?.tcgCode ?? null,
    setId,
    setName: set?.name ?? null,
    catalogue,
    read,
    ownedCount: null,
    totalCount: null,
    missingCount: null,
    completionPercent: null,
    missingCards: Object.freeze([]),
  });
}

export async function getCollectionSetProgressFromStore(store, {
  userId,
  setId,
  preferredLanguageCode = null,
  preferredVariantCode = 'standard',
} = {}) {
  const ownerId = requireText(userId, 'userId');
  const canonicalSetId = requireText(setId, 'setId');
  const set = await getVerifiedSet(store, canonicalSetId);
  if (!set) return unavailable({ reason:'verified_set_not_found', setId:canonicalSetId });

  const cardRead = await readCollectorVerifiedSetCardsFromStore(store, { setId:canonicalSetId });
  if(cardRead.truncated){
    return unavailable({
      reason:'canonical_set_read_truncated',setId:canonicalSetId,set,
      read:Object.freeze({totalCards:cardRead.totalCards,maxCards:cardRead.maxCards,truncated:true}),
    });
  }
  const canonicalCards=cardRead.cards;
  const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards });
  if (catalogue.status !== 'complete') {
    return unavailable({
      reason: catalogue.reason,
      setId: canonicalSetId,
      set,
      catalogue,
      read:Object.freeze({totalCards:cardRead.totalCards,maxCards:cardRead.maxCards,truncated:false}),
    });
  }

  const collectionRead=await readCollectorCollectionItemsFromStore(store,{userId:ownerId});
  if(collectionRead.truncated){
    return unavailable({
      reason:'collection_read_truncated',setId:canonicalSetId,set,catalogue,
      read:Object.freeze({
        totalCards:cardRead.totalCards,
        collectionItemsTotal:collectionRead.totalItems,
        collectionUnitsTotal:collectionRead.totalUnits,
        collectionMaxItems:collectionRead.maxItems,
        truncated:true,
      }),
    });
  }
  const progress = computeCollectionSetProgress({
    set,
    canonicalCards,
    collectionItems:collectionRead.items,
    preferredLanguageCode,
    preferredVariantCode,
  });

  return Object.freeze({
    ...progress,
    catalogue,
    read:Object.freeze({
      totalCards:cardRead.totalCards,
      collectionItemsTotal:collectionRead.totalItems,
      collectionUnitsTotal:collectionRead.totalUnits,
      truncated:false,
    }),
  });
}
