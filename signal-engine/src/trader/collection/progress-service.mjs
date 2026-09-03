import { listCollectionItemsFromStore } from './store.mjs';
import { computeCollectionSetProgress } from './set-progress.mjs';
import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { listVerifiedCardsFromStore, listVerifiedCardSetsFromStore } from '../catalogue/store.mjs';
import { SUPPORTED_TCG_CODES } from '../tcg-registry.mjs';

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

function unavailable({ reason, setId, set = null, catalogue = null }) {
  return Object.freeze({
    status: 'unavailable',
    reason,
    tcgCode: set?.tcgCode ?? null,
    setId,
    setName: set?.name ?? null,
    catalogue,
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

  const canonicalCards = await listVerifiedCardsFromStore(store, { setId: canonicalSetId, limit: 500 });
  const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards });
  if (catalogue.status !== 'complete') {
    return unavailable({
      reason: catalogue.reason,
      setId: canonicalSetId,
      set,
      catalogue,
    });
  }

  const collectionItems = await listCollectionItemsFromStore(store, { userId: ownerId, limit: 2000 });
  const progress = computeCollectionSetProgress({
    set,
    canonicalCards,
    collectionItems,
    preferredLanguageCode,
    preferredVariantCode,
  });

  return Object.freeze({ ...progress, catalogue });
}
