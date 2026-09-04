import { adaptPokemonTcgSet } from './pokemontcg-adapter.mjs';
import { adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { buildVerifiedPokemonSetCrosswalk } from './bulk-sync.mjs';
import { normaliseComparableName, reconcileSetEvidence } from './reconcile.mjs';
import {
  REVIEWED_SET_ALIASES,
  classifyPokemonSetForPulse,
  summarisePokemonPulseSetUniverse,
} from './pokemon-set-policy.mjs';

function requireClient(client, name) {
  if (!client || typeof client.getSet !== 'function' || typeof client.listSets !== 'function') {
    throw new TypeError(`${name}.getSet/listSets are required`);
  }
  return client;
}

function sourceFailure(sourceName, sourceRecordId, error) {
  return Object.freeze({
    sourceName,
    sourceRecordId,
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

function aliasEvidence(alias, tcgdexEvidence, pokemonEvidence) {
  const actualTcgdexName = normaliseComparableName(tcgdexEvidence.setName);
  const reviewedTcgdexName = normaliseComparableName(alias.tcgdexName);
  const actualPokemonName = normaliseComparableName(pokemonEvidence.setName);
  const reviewedPokemonName = normaliseComparableName(alias.pokemonTcgName);
  if (actualTcgdexName !== reviewedTcgdexName || actualPokemonName !== reviewedPokemonName) {
    return Object.freeze({
      status: 'conflict',
      field: 'reviewedAliasSourceName',
      left: tcgdexEvidence.setName,
      right: pokemonEvidence.setName,
    });
  }

  const reconciled = reconcileSetEvidence(
    Object.freeze({ ...tcgdexEvidence, setName: alias.pokemonTcgName }),
    pokemonEvidence,
  );
  if (reconciled.status !== 'matched') return reconciled;

  return Object.freeze({
    ...reconciled,
    acceptedDifferences: Object.freeze([
      ...(reconciled.acceptedDifferences || []),
      Object.freeze({
        field: 'setName',
        left: tcgdexEvidence.setName,
        right: pokemonEvidence.setName,
        reason: alias.reason,
      }),
    ]),
  });
}

function rowForUniverse(pair) {
  return Object.freeze({
    tcgdexSetId: pair.tcgdexSetId,
    pokemonTcgSetId: pair.pokemonTcgSetId,
    canonicalSetId: pair.setMatch?.canonicalSetId ?? null,
    seriesName: pair.setMatch?.seriesName ?? null,
    setName: pair.setMatch?.setName ?? null,
    releasedAt: pair.setMatch?.releasedAt ?? null,
    printedTotal: pair.setMatch?.printedTotal ?? null,
    total: pair.setMatch?.total ?? null,
    matchBasis: pair.matchBasis ?? 'exact_name',
  });
}

export async function buildReviewedPokemonSetCrosswalk({
  tcgdexClient,
  pokemonTcgClient,
  asOf = Date.now(),
} = {}) {
  const tcgdex = requireClient(tcgdexClient, 'tcgdexClient');
  const pokemon = requireClient(pokemonTcgClient, 'pokemonTcgClient');
  const base = await buildVerifiedPokemonSetCrosswalk({ tcgdexClient: tcgdex, pokemonTcgClient: pokemon });
  const matchedTcgdex = new Set(base.matched.map((row) => row.tcgdexSetId));
  const matchedPokemon = new Set(base.matched.map((row) => row.pokemonTcgSetId));
  const reviewedAliasMatched = [];
  const reviewedAliasRejected = [];
  const sourceErrors = [];
  let pokemonBriefIndexPromise = null;

  const getPokemonBriefIndex = async () => {
    if (!pokemonBriefIndexPromise) {
      pokemonBriefIndexPromise = Promise.resolve(pokemon.listSets()).then((rows) => {
        if (!Array.isArray(rows)) throw new TypeError('pokemonTcgClient.listSets() must return an array');
        return new Map(rows.map((row) => [String(row?.id ?? '').trim(), row]).filter(([id]) => id));
      });
    }
    return pokemonBriefIndexPromise;
  };

  for (const alias of REVIEWED_SET_ALIASES) {
    if (matchedTcgdex.has(alias.tcgdexSetId) || matchedPokemon.has(alias.pokemonTcgSetId)) continue;
    let tcgdexEvidence;
    let pokemonEvidence;
    try {
      tcgdexEvidence = adaptTcgdexSet(await tcgdex.getSet(alias.tcgdexSetId));
    } catch (error) {
      sourceErrors.push(sourceFailure('tcgdex', alias.tcgdexSetId, error));
      continue;
    }
    try {
      pokemonEvidence = adaptPokemonTcgSet(await pokemon.getSet(alias.pokemonTcgSetId));
    } catch (error) {
      const fallback = (await getPokemonBriefIndex()).get(alias.pokemonTcgSetId) || null;
      if (!pokemonBriefHasFullSetEvidence(fallback)) {
        sourceErrors.push(sourceFailure('pokemontcg-api', alias.pokemonTcgSetId, error));
        continue;
      }
      pokemonEvidence = adaptPokemonTcgSet(fallback);
    }

    const result = aliasEvidence(alias, tcgdexEvidence, pokemonEvidence);
    if (result.status === 'matched') {
      const row = Object.freeze({
        tcgdexSetId: alias.tcgdexSetId,
        pokemonTcgSetId: alias.pokemonTcgSetId,
        matchBasis: 'reviewed_alias',
        aliasReason: alias.reason,
        setMatch: result,
      });
      reviewedAliasMatched.push(row);
      matchedTcgdex.add(alias.tcgdexSetId);
      matchedPokemon.add(alias.pokemonTcgSetId);
    } else {
      reviewedAliasRejected.push(Object.freeze({
        tcgdexSetId: alias.tcgdexSetId,
        pokemonTcgSetId: alias.pokemonTcgSetId,
        aliasReason: alias.reason,
        status: result.status,
        reason: result.reason ?? null,
        field: result.field ?? null,
        left: result.left ?? null,
        right: result.right ?? null,
      }));
    }
  }

  const matched = Object.freeze([
    ...base.matched.map((row) => Object.freeze({ ...row, matchBasis: 'exact_name' })),
    ...reviewedAliasMatched,
  ].sort((left, right) => {
    const leftTime = left.setMatch?.releasedAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.setMatch?.releasedAt ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.setMatch?.setName || '').localeCompare(String(right.setMatch?.setName || ''));
  }));

  const universe = summarisePokemonPulseSetUniverse(matched.map(rowForUniverse), { asOf });
  const eligible = Object.freeze(universe.sets.filter((row) => row.pulseEligibility.eligibleForGlobalPulse));
  const excluded = Object.freeze(universe.sets.filter((row) => !row.pulseEligibility.eligibleForGlobalPulse));

  return Object.freeze({
    base,
    counts: Object.freeze({
      baseMatched: base.matched.length,
      reviewedAliasMatched: reviewedAliasMatched.length,
      reviewedAliasRejected: reviewedAliasRejected.length,
      sourceErrors: sourceErrors.length,
      totalMatched: matched.length,
      pulseEligible: eligible.length,
      pulseExcluded: excluded.length,
    }),
    matched,
    reviewedAliasMatched: Object.freeze(reviewedAliasMatched),
    reviewedAliasRejected: Object.freeze(reviewedAliasRejected),
    sourceErrors: Object.freeze(sourceErrors),
    universe,
    eligible,
    excluded,
  });
}

export function explainPokemonPulseEligibility(pair, options = {}) {
  return classifyPokemonSetForPulse(rowForUniverse(pair), options);
}
