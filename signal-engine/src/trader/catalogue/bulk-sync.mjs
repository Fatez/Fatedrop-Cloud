import { adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { adaptPokemonTcgSet } from './pokemontcg-adapter.mjs';
import { normaliseComparableName, reconcileSetEvidence } from './reconcile.mjs';
import { syncVerifiedPokemonSet } from './sync.mjs';

function requireClient(client, name) {
  if (!client || typeof client.listSets !== 'function' || typeof client.getSet !== 'function') {
    throw new TypeError(`${name} with listSets/getSet is required`);
  }
  return client;
}

function sourceId(value, field) {
  const id = String(value ?? '').trim();
  if (!id) throw new TypeError(`${field} is required`);
  return id;
}

function sourceName(value, field) {
  const name = String(value ?? '').trim();
  if (!name) throw new TypeError(`${field} is required`);
  return name;
}

function byReleaseNameId(a, b) {
  const leftTime = a?.setMatch?.releasedAt ?? Number.MAX_SAFE_INTEGER;
  const rightTime = b?.setMatch?.releasedAt ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) return leftTime - rightTime;
  const nameCompare = String(a?.setMatch?.setName || '').localeCompare(String(b?.setMatch?.setName || ''));
  if (nameCompare !== 0) return nameCompare;
  return String(a?.tcgdexSetId || '').localeCompare(String(b?.tcgdexSetId || ''));
}

function compactCandidate(candidate, result) {
  return Object.freeze({
    pokemonTcgSetId: sourceId(candidate.id, 'pokemon set id'),
    pokemonTcgSetName: sourceName(candidate.name, 'pokemon set name'),
    status: result.status,
    reason: result.reason ?? null,
    field: result.field ?? null,
    left: result.left ?? null,
    right: result.right ?? null,
  });
}

function sourceFailure(sourceNameValue, sourceRecordId, setName, error) {
  return Object.freeze({
    sourceName: sourceNameValue,
    sourceRecordId,
    setName,
    status: error?.status ?? null,
    sourceUrl: error?.sourceUrl ?? null,
    message: error?.message || String(error),
  });
}

function pokemonBriefHasFullSetEvidence(set) {
  return typeof set?.series === 'string'
    && set.series.trim() !== ''
    && typeof set?.releaseDate === 'string'
    && Number.isInteger(set?.printedTotal)
    && Number.isInteger(set?.total);
}

function setIdsFromSeries(series) {
  if (!Array.isArray(series?.sets)) return new Set();
  return new Set(series.sets.map((set) => String(set?.id ?? '').trim()).filter(Boolean));
}

export async function buildVerifiedPokemonSetCrosswalk({ tcgdexClient, pokemonTcgClient } = {}) {
  const tcgdex = requireClient(tcgdexClient, 'tcgdexClient');
  const pokemon = requireClient(pokemonTcgClient, 'pokemonTcgClient');
  const [tcgdexBriefs, pokemonBriefs] = await Promise.all([tcgdex.listSets(), pokemon.listSets()]);
  if (!Array.isArray(tcgdexBriefs) || !Array.isArray(pokemonBriefs)) {
    throw new TypeError('catalogue source set listings must be arrays');
  }

  const sourceErrors = [];
  let pocketSetIds = new Set();
  if (typeof tcgdex.getSeries === 'function') {
    try {
      pocketSetIds = setIdsFromSeries(await tcgdex.getSeries('tcgp'));
    } catch (error) {
      sourceErrors.push(sourceFailure('tcgdex', 'series:tcgp', 'Pokémon TCG Pocket exclusion', error));
    }
  }
  const physicalTcgdexBriefs = tcgdexBriefs.filter((set) => !pocketSetIds.has(String(set?.id ?? '').trim()));

  const pokemonByName = new Map();
  for (const set of pokemonBriefs) {
    const key = normaliseComparableName(sourceName(set.name, 'pokemon set name'));
    const rows = pokemonByName.get(key) || [];
    rows.push(set);
    pokemonByName.set(key, rows);
  }

  const tcgdexFullCache = new Map();
  const pokemonFullCache = new Map();
  const getTcgdexFull = async (id) => {
    if (!tcgdexFullCache.has(id)) tcgdexFullCache.set(id, Promise.resolve(tcgdex.getSet(id)));
    return tcgdexFullCache.get(id);
  };
  const getPokemonFull = async (candidate) => {
    if (pokemonBriefHasFullSetEvidence(candidate)) return candidate;
    const id = sourceId(candidate.id, 'pokemon set id');
    if (!pokemonFullCache.has(id)) pokemonFullCache.set(id, Promise.resolve(pokemon.getSet(id)));
    return pokemonFullCache.get(id);
  };

  const matched = [];
  const ambiguous = [];
  const rejected = [];
  const unmatchedTcgdex = [];
  const claimedPokemonIds = new Set();

  const orderedTcgdex = [...physicalTcgdexBriefs].sort((a, b) => {
    const nameCompare = String(a?.name || '').localeCompare(String(b?.name || ''));
    if (nameCompare !== 0) return nameCompare;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  for (const brief of orderedTcgdex) {
    const tcgdexSetId = sourceId(brief.id, 'tcgdex set id');
    const tcgdexSetName = sourceName(brief.name, 'tcgdex set name');
    const key = normaliseComparableName(tcgdexSetName);
    const candidates = pokemonByName.get(key) || [];
    if (candidates.length === 0) {
      unmatchedTcgdex.push(Object.freeze({ tcgdexSetId, tcgdexSetName, reason: 'no_name_candidate' }));
      continue;
    }

    let tcgdexEvidence;
    try {
      tcgdexEvidence = adaptTcgdexSet(await getTcgdexFull(tcgdexSetId));
    } catch (error) {
      sourceErrors.push(sourceFailure('tcgdex', tcgdexSetId, tcgdexSetName, error));
      continue;
    }

    const candidateResults = [];
    let candidateSourceFailures = 0;
    for (const candidate of candidates) {
      const pokemonTcgSetId = sourceId(candidate.id, 'pokemon set id');
      try {
        const pokemonEvidence = adaptPokemonTcgSet(await getPokemonFull(candidate));
        const result = reconcileSetEvidence(tcgdexEvidence, pokemonEvidence);
        candidateResults.push({ candidate, result });
      } catch (error) {
        candidateSourceFailures += 1;
        sourceErrors.push(sourceFailure('pokemontcg-api', pokemonTcgSetId, sourceName(candidate.name, 'pokemon set name'), error));
      }
    }

    if (candidateResults.length === 0) continue;
    const viable = candidateResults.filter((entry) => entry.result.status === 'matched');
    const everyCandidateResolved = candidateSourceFailures === 0 && candidateResults.length === candidates.length;
    if (viable.length === 1 && everyCandidateResolved) {
      const chosen = viable[0];
      const pokemonTcgSetId = sourceId(chosen.candidate.id, 'pokemon set id');
      claimedPokemonIds.add(pokemonTcgSetId);
      matched.push(Object.freeze({
        tcgdexSetId,
        pokemonTcgSetId,
        setMatch: chosen.result,
      }));
      continue;
    }

    const compact = Object.freeze(candidateResults.map(({ candidate, result }) => compactCandidate(candidate, result)));
    if (viable.length > 1 || candidates.length > 1 || candidateSourceFailures > 0) {
      ambiguous.push(Object.freeze({
        tcgdexSetId,
        tcgdexSetName,
        candidates: compact,
        unresolvedSourceCandidates: candidateSourceFailures,
      }));
    } else {
      const only = candidateResults[0];
      rejected.push(Object.freeze({
        tcgdexSetId,
        tcgdexSetName,
        pokemonTcgSetId: sourceId(only.candidate.id, 'pokemon set id'),
        status: only.result.status,
        reason: only.result.reason ?? null,
        field: only.result.field ?? null,
        left: only.result.left ?? null,
        right: only.result.right ?? null,
      }));
    }
  }

  matched.sort(byReleaseNameId);
  ambiguous.sort((a, b) => a.tcgdexSetName.localeCompare(b.tcgdexSetName) || a.tcgdexSetId.localeCompare(b.tcgdexSetId));
  rejected.sort((a, b) => a.tcgdexSetName.localeCompare(b.tcgdexSetName) || a.tcgdexSetId.localeCompare(b.tcgdexSetId));
  unmatchedTcgdex.sort((a, b) => a.tcgdexSetName.localeCompare(b.tcgdexSetName) || a.tcgdexSetId.localeCompare(b.tcgdexSetId));
  sourceErrors.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.setName.localeCompare(b.setName) || a.sourceRecordId.localeCompare(b.sourceRecordId));

  const unmatchedPokemon = pokemonBriefs
    .filter((set) => !claimedPokemonIds.has(sourceId(set.id, 'pokemon set id')))
    .map((set) => Object.freeze({
      pokemonTcgSetId: sourceId(set.id, 'pokemon set id'),
      pokemonTcgSetName: sourceName(set.name, 'pokemon set name'),
    }))
    .sort((a, b) => a.pokemonTcgSetName.localeCompare(b.pokemonTcgSetName) || a.pokemonTcgSetId.localeCompare(b.pokemonTcgSetId));

  return Object.freeze({
    sourceCounts: Object.freeze({
      tcgdex: physicalTcgdexBriefs.length,
      tcgdexAll: tcgdexBriefs.length,
      tcgdexPocketExcluded: pocketSetIds.size,
      pokemonTcgApi: pokemonBriefs.length,
    }),
    counts: Object.freeze({
      matched: matched.length,
      ambiguous: ambiguous.length,
      rejected: rejected.length,
      sourceErrors: sourceErrors.length,
      unmatchedTcgdex: unmatchedTcgdex.length,
      unmatchedPokemon: unmatchedPokemon.length,
    }),
    matched: Object.freeze(matched),
    ambiguous: Object.freeze(ambiguous),
    rejected: Object.freeze(rejected),
    sourceErrors: Object.freeze(sourceErrors),
    unmatchedTcgdex: Object.freeze(unmatchedTcgdex),
    unmatchedPokemon: Object.freeze(unmatchedPokemon),
  });
}

export async function syncVerifiedPokemonCatalogue({
  store,
  tcgdexClient,
  pokemonTcgClient,
  crosswalk = null,
  startAfterSetId = null,
  maxSets = 10,
  maxCardsPerChunk = 100,
  verifiedAt = Date.now(),
} = {}) {
  if (!store) throw new TypeError('store is required');
  const tcgdex = requireClient(tcgdexClient, 'tcgdexClient');
  const pokemon = requireClient(pokemonTcgClient, 'pokemonTcgClient');
  const plan = crosswalk || await buildVerifiedPokemonSetCrosswalk({ tcgdexClient: tcgdex, pokemonTcgClient: pokemon });
  if (!Array.isArray(plan?.matched)) throw new TypeError('crosswalk.matched is required');

  let startIndex = 0;
  if (startAfterSetId) {
    const found = plan.matched.findIndex((entry) => entry.tcgdexSetId === String(startAfterSetId));
    if (found < 0) throw new Error('Catalogue set cursor does not belong to the verified crosswalk');
    startIndex = found + 1;
  }

  const safeMaxSets = Math.min(100, Math.max(1, Number(maxSets) || 10));
  const selected = plan.matched.slice(startIndex, startIndex + safeMaxSets);
  const totals = {
    setsCompleted: 0,
    sourceCardsProcessed: 0,
    matchedCardRecords: 0,
    verifiedCardIdentities: 0,
    cardConflicts: 0,
    quarantined: 0,
    unmatchedCards: 0,
    savedSets: 0,
    savedPrintings: 0,
    savedCards: 0,
  };
  const sets = [];
  let lastCompletedSetId = startAfterSetId ? String(startAfterSetId) : null;

  for (const pair of selected) {
    let cardCursor = null;
    const setTotals = {
      sourceCardsProcessed: 0,
      matchedCardRecords: 0,
      verifiedCardIdentities: 0,
      cardConflicts: 0,
      quarantined: 0,
      unmatchedCards: 0,
      savedPrintings: 0,
      savedCards: 0,
    };
    try {
      while (true) {
        const result = await syncVerifiedPokemonSet({
          store,
          tcgdexClient: tcgdex,
          pokemonTcgClient: pokemon,
          tcgdexSetId: pair.tcgdexSetId,
          pokemonTcgSetId: pair.pokemonTcgSetId,
          cursor: cardCursor,
          maxCards: maxCardsPerChunk,
          verifiedAt,
        });
        if (result.status !== 'partial' && result.status !== 'complete' && result.status !== 'empty') {
          throw new Error(`Verified crosswalk changed during sync: ${pair.tcgdexSetId} returned ${result.status}`);
        }
        setTotals.sourceCardsProcessed += result.processedSourceCards || 0;
        setTotals.matchedCardRecords += result.matchedCardRecords || 0;
        setTotals.verifiedCardIdentities += result.verifiedCardIdentities || 0;
        setTotals.cardConflicts += result.conflicts || 0;
        setTotals.quarantined += result.quarantined || 0;
        setTotals.unmatchedCards += result.unmatched || 0;
        setTotals.savedPrintings += result.persistence?.savedPrintings || 0;
        setTotals.savedCards += result.persistence?.savedCards || 0;
        if (result.status !== 'partial') break;
        cardCursor = result.nextCursor;
        if (!cardCursor) throw new Error('Partial catalogue sync did not return a card cursor');
      }
    } catch (error) {
      error.catalogueResume = Object.freeze({
        startAfterSetId: lastCompletedSetId,
        failedSetId: pair.tcgdexSetId,
        restartFailedSetFromBeginning: true,
      });
      throw error;
    }

    totals.setsCompleted += 1;
    totals.sourceCardsProcessed += setTotals.sourceCardsProcessed;
    totals.matchedCardRecords += setTotals.matchedCardRecords;
    totals.verifiedCardIdentities += setTotals.verifiedCardIdentities;
    totals.cardConflicts += setTotals.cardConflicts;
    totals.quarantined += setTotals.quarantined;
    totals.unmatchedCards += setTotals.unmatchedCards;
    totals.savedSets += 1;
    totals.savedPrintings += setTotals.savedPrintings;
    totals.savedCards += setTotals.savedCards;
    lastCompletedSetId = pair.tcgdexSetId;
    sets.push(Object.freeze({
      tcgdexSetId: pair.tcgdexSetId,
      pokemonTcgSetId: pair.pokemonTcgSetId,
      canonicalSetId: pair.setMatch?.canonicalSetId ?? null,
      setName: pair.setMatch?.setName ?? null,
      ...setTotals,
    }));
  }

  const hasMore = startIndex + selected.length < plan.matched.length;
  return Object.freeze({
    status: hasMore ? 'partial' : 'complete',
    crosswalkCounts: plan.counts,
    totals: Object.freeze(totals),
    sets: Object.freeze(sets),
    nextSetCursor: hasMore ? lastCompletedSetId : null,
  });
}
