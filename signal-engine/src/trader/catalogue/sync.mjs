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

export async function syncVerifiedPokemonSet({
  store,
  tcgdexClient,
  pokemonTcgClient,
  tcgdexSetId,
  pokemonTcgSetId,
  cursor = null,
  maxCards = 100,
  verifiedAt = Date.now(),
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

  // Deliberately sequential for the first controlled sync. Provider-friendly
  // bounded concurrency can be introduced only after rate-limit telemetry exists.
  const tcgdexCards = [];
  for (const cardId of selectedRefs) tcgdexCards.push(await tcgdex.getCard(cardId));
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
    unmatched: cardResults.unmatched.length,
    persistence,
    nextCursor: hasMore ? lastProcessed : null,
  });
}
