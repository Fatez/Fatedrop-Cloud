import { adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { adaptPokemonTcgSet } from './pokemontcg-adapter.mjs';
import { reconcileSetEvidence } from './reconcile.mjs';
import { reconcilePokemonCardCollections } from './pipeline.mjs';
import { promoteMatchedCardEvidence } from './verification.mjs';
import { buildVerifiedCatalogueBatch } from './persistence.mjs';
import { persistVerifiedCatalogueBatch } from './store.mjs';

function requireClient(client, name) {
  if (!client || typeof client.getSet !== 'function') throw new TypeError(`${name} is required`);
  return client;
}

function cardRefId(ref) {
  const id = String(ref?.id || '').trim();
  return id || null;
}

async function mapConcurrent(items, concurrency, mapper) {
  const limit = Math.max(1, Math.min(8, Number(concurrency) || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function fetchTcgdexCardOrMissing(tcgdex, cardId) {
  try {
    return { card: await tcgdex.getCard(cardId), missing: null };
  } catch (error) {
    // A set listing can temporarily retain a card reference that the card endpoint
    // no longer serves. Fail closed for that one identity rather than fabricating
    // evidence or aborting the rest of an otherwise verifiable catalogue.
    if (error?.status !== 404) throw error;
    return {
      card: null,
      missing: Object.freeze({
        sourceName: 'tcgdex',
        sourceRecordId: String(cardId),
        status: 404,
        sourceUrl: error.sourceUrl ?? null,
        reason: 'source_card_reference_not_found',
      }),
    };
  }
}

export async function syncVerifiedPokemonSet({
  store,
  tcgdexClient,
  pokemonTcgClient,
  tcgdexSetId,
  pokemonTcgSetId,
  cursor = null,
  maxCards = 100,
  verifiedAt = Date.now(),
  tcgdexConcurrency = 4,
} = {}) {
  const tcgdex = requireClient(tcgdexClient, 'tcgdexClient');
  const pokemon = requireClient(pokemonTcgClient, 'pokemonTcgClient');
  if (typeof tcgdex.getCard !== 'function') throw new TypeError('tcgdexClient.getCard is required');
  if (typeof pokemon.listCardsBySet !== 'function') throw new TypeError('pokemonTcgClient.listCardsBySet is required');

  const [rawTcgdexSet, rawPokemonSet] = await Promise.all([
    tcgdex.getSet(tcgdexSetId),
    pokemon.getSet(pokemonTcgSetId),
  ]);
  const tcgdexSet = adaptTcgdexSet(rawTcgdexSet);
  const pokemonSet = adaptPokemonTcgSet(rawPokemonSet);
  const setMatch = reconcileSetEvidence(tcgdexSet, pokemonSet);
  if (setMatch.status !== 'matched') {
    return Object.freeze({
      status: setMatch.status,
      persisted: false,
      setResult: setMatch,
      nextCursor: null,
    });
  }

  if (!Array.isArray(rawTcgdexSet.cards)) {
    throw new TypeError('TCGdex full set payload must contain cards[]');
  }
  const refs = rawTcgdexSet.cards.map(cardRefId).filter(Boolean);
  if (!refs.length) {
    return Object.freeze({ status: 'empty', persisted: false, setResult: setMatch, nextCursor: null });
  }

  let startIndex = 0;
  if (cursor) {
    const cursorIndex = refs.indexOf(String(cursor));
    if (cursorIndex < 0) throw new Error('Catalogue sync cursor does not belong to this source set');
    startIndex = cursorIndex + 1;
  }
  const safeMax = Math.min(250, Math.max(1, Number(maxCards) || 100));
  const selectedRefs = refs.slice(startIndex, startIndex + safeMax);
  if (!selectedRefs.length) {
    return Object.freeze({ status: 'complete', persisted: false, setResult: setMatch, nextCursor: null });
  }

  const fetched = await mapConcurrent(
    selectedRefs,
    tcgdexConcurrency,
    (cardId) => fetchTcgdexCardOrMissing(tcgdex, cardId),
  );
  const tcgdexCards = fetched.map((entry) => entry.card).filter(Boolean);
  const unavailableSourceCards = fetched.map((entry) => entry.missing).filter(Boolean);
  const pokemonCards = await pokemon.listCardsBySet(pokemonTcgSetId);

  const cardResults = reconcilePokemonCardCollections({
    tcgdexCards,
    pokemonTcgCards: pokemonCards,
    setMatch,
    sourceSeriesCode: tcgdexSet.sourceSeriesCode,
    languageCode: tcgdexSet.languageCode,
  });

  const promotions = cardResults.matched.map((match) => promoteMatchedCardEvidence(match, { verifiedAt }));
  const rejectedPromotion = promotions.find((promotion) => promotion.status !== 'verified');
  if (rejectedPromotion) throw new Error(`Catalogue verification promotion failed: ${rejectedPromotion.reason || 'unknown'}`);

  let persistence = { savedSets: 0, savedPrintings: 0, savedCards: 0 };
  if (promotions.length) {
    const batch = buildVerifiedCatalogueBatch({ setMatch, promotions, verifiedAt });
    persistence = await persistVerifiedCatalogueBatch(store, batch);
  }

  const lastProcessed = selectedRefs[selectedRefs.length - 1];
  const hasMore = startIndex + selectedRefs.length < refs.length;
  return Object.freeze({
    status: hasMore ? 'partial' : 'complete',
    persisted: promotions.length > 0,
    canonicalSetId: setMatch.canonicalSetId,
    processedSourceCards: selectedRefs.length,
    matchedCardRecords: cardResults.matched.length,
    verifiedCardIdentities: promotions.reduce((sum, promotion) => sum + promotion.identities.length, 0),
    conflicts: cardResults.conflicts.length,
    quarantined: cardResults.quarantined.length,
    ...(cardResults.unsupportedPublisherEvidence ? { unsupportedPublisherEvidence: cardResults.unsupportedPublisherEvidence } : {}),
    ...(unavailableSourceCards.length ? { unavailableSourceCards: Object.freeze(unavailableSourceCards) } : {}),
    unmatched: cardResults.unmatched.length + unavailableSourceCards.length,
    persistence,
    nextCursor: hasMore ? lastProcessed : null,
  });
}
