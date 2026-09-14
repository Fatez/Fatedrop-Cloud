import {
  getVerifiedCardFromStore as getVerifiedCardWithoutArtworkFromStore,
  getVerifiedCardSetFromStore,
  listVerifiedCardsFromStore as listVerifiedCardsWithoutArtworkFromStore,
  listVerifiedCardSeriesFromStore,
  listVerifiedCardSetsFromStore,
} from './store.mjs';
import { enrichCardsWithArtworkFromStore } from './artwork-read.mjs';

export { getVerifiedCardSetFromStore, listVerifiedCardSeriesFromStore, listVerifiedCardSetsFromStore };

export async function listVerifiedCardsFromStore(store, options = {}) {
  const cards = await listVerifiedCardsWithoutArtworkFromStore(store, options);
  return enrichCardsWithArtworkFromStore(store, cards);
}

export async function getVerifiedCardFromStore(store, cardIdentityId) {
  const card = await getVerifiedCardWithoutArtworkFromStore(store, cardIdentityId);
  return enrichCardsWithArtworkFromStore(store, card);
}
