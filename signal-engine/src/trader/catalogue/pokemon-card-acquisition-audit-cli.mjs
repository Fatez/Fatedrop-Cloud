import { adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { adaptPokemonTcgSet } from './pokemontcg-adapter.mjs';
import { reconcileSetEvidence } from './reconcile.mjs';
import { reconcilePokemonCardCollections } from './pipeline.mjs';
import { promoteMatchedCardEvidence } from './verification.mjs';
import { createPokemonTcgClient, createTcgdexClient } from './source-clients.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : null;
}

function requireArg(name) {
  const value = argValue(name);
  if (!value) throw new TypeError(`--${name}=... is required`);
  return value;
}

function cardRefId(ref) {
  const id = String(ref?.id || '').trim();
  return id || null;
}

function breakdown(rows) {
  const counts = {};
  for (const row of rows) {
    const reason = row?.reason || row?.field || row?.status || 'unknown';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

async function main() {
  const tcgdexSetId = requireArg('tcgdex-set');
  const pokemonTcgSetId = requireArg('pokemon-set');
  const verifiedAtArg = argValue('verified-at');
  const verifiedAt = verifiedAtArg ? Date.parse(verifiedAtArg) : Date.now();
  if (!Number.isFinite(verifiedAt)) throw new TypeError('--verified-at must be a valid date/time');

  const tcgdex = createTcgdexClient({ languageCode: 'en' });
  const pokemon = createPokemonTcgClient({ apiKey: process.env.POKEMON_TCG_API_KEY || null });
  const [rawTcgdexSet, rawPokemonSet] = await Promise.all([
    tcgdex.getSet(tcgdexSetId),
    pokemon.getSet(pokemonTcgSetId),
  ]);
  const tcgdexSet = adaptTcgdexSet(rawTcgdexSet);
  const pokemonSet = adaptPokemonTcgSet(rawPokemonSet);
  const setMatch = reconcileSetEvidence(tcgdexSet, pokemonSet);
  if (setMatch.status !== 'matched') {
    throw new Error(`set reconciliation failed: ${JSON.stringify(setMatch)}`);
  }
  if (!Array.isArray(rawTcgdexSet.cards)) throw new TypeError('TCGdex full set payload must contain cards[]');

  const cardIds = rawTcgdexSet.cards.map(cardRefId).filter(Boolean);
  const tcgdexCards = [];
  for (const id of cardIds) tcgdexCards.push(await tcgdex.getCard(id));
  const pokemonCards = await pokemon.listCardsBySet(pokemonTcgSetId);

  const reconciled = reconcilePokemonCardCollections({
    tcgdexCards,
    pokemonTcgCards: pokemonCards,
    setMatch,
    sourceSeriesCode: tcgdexSet.sourceSeriesCode,
    languageCode: 'en',
  });
  const promotions = reconciled.matched.map((match) => promoteMatchedCardEvidence(match, { verifiedAt }));
  const rejectedPromotions = promotions.filter((promotion) => promotion.status !== 'verified');
  const identities = promotions.flatMap((promotion) => promotion.status === 'verified' ? promotion.identities : []);
  const distinctPrintingIds = new Set(identities.map((identity) => identity.printingId).filter(Boolean));
  const distinctFateCardIds = new Set(identities.map((identity) => identity.fateCardId).filter(Boolean));
  const pokemonTcgSetCode = typeof rawPokemonSet?.ptcgoCode === 'string' && rawPokemonSet.ptcgoCode.trim()
    ? rawPokemonSet.ptcgoCode.trim()
    : null;

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    set: {
      tcgdexSetId,
      pokemonTcgSetId,
      pokemonTcgSetCode,
      canonicalSetId: setMatch.canonicalSetId,
      seriesName: setMatch.seriesName,
      setName: setMatch.setName,
      printedTotal: setMatch.printedTotal,
      total: setMatch.total,
      acceptedDifferences: setMatch.acceptedDifferences,
    },
    sourceCounts: {
      tcgdexCardRefs: cardIds.length,
      tcgdexCardsFetched: tcgdexCards.length,
      pokemonTcgCardsFetched: pokemonCards.length,
    },
    reconciliation: {
      matchedCardRecords: reconciled.matched.length,
      conflicts: reconciled.conflicts.length,
      quarantined: reconciled.quarantined.length,
      unmatched: reconciled.unmatched.length,
      conflictReasons: breakdown(reconciled.conflicts),
      quarantineReasons: breakdown(reconciled.quarantined),
      unmatchedReasons: breakdown(reconciled.unmatched),
    },
    verification: {
      verifiedIdentityRows: identities.length,
      distinctFateCardIds: distinctFateCardIds.size,
      distinctPrintingIds: distinctPrintingIds.size,
      rejectedPromotions: rejectedPromotions.length,
    },
    diagnostics: {
      conflicts: reconciled.conflicts.slice(0, 50),
      quarantined: reconciled.quarantined.slice(0, 50),
      unmatched: reconciled.unmatched.slice(0, 50),
      rejectedPromotions: rejectedPromotions.slice(0, 50),
    },
    identities,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
