import { listCollectionItemsFromStore } from './store.mjs';
import { computeCollectionSetProgress } from './set-progress.mjs';
import { listVerifiedCardsFromStore, listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

async function getVerifiedSet(store, setId) {
  const id = requireText(setId, 'setId');
  const tcgCodes = ['pokemon', 'one-piece', 'lorcana'];
  for (const tcgCode of tcgCodes) {
    const sets = await listVerifiedCardSetsFromStore(store, { tcgCode, limit: 1000 });
    const match = sets.find((set) => set.id === id);
    if (match) return match;
  }
  return null;
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
  if (!set) {
    return Object.freeze({
      status: 'unavailable',
      reason: 'verified_set_not_found',
      setId: canonicalSetId,
      ownedCount: null,
      totalCount: null,
      missingCount: null,
      completionPercent: null,
      missingCards: Object.freeze([]),
    });
  }

  const [canonicalCards, collectionItems] = await Promise.all([
    listVerifiedCardsFromStore(store, { setId: canonicalSetId, limit: 500 }),
    listCollectionItemsFromStore(store, { userId: ownerId, limit: 2000 }),
  ]);

  return computeCollectionSetProgress({
    set,
    canonicalCards,
    collectionItems,
    preferredLanguageCode,
    preferredVariantCode,
  });
}
