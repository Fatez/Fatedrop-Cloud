import { normaliseCollectorNumber } from '../card-identity.mjs';
import { adaptTcgdexCard, adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { adaptPokemonTcgCardEvidence, adaptPokemonTcgSet } from './pokemontcg-adapter.mjs';
import { normaliseComparableName, reconcileCardEvidence, reconcileSetEvidence } from './reconcile.mjs';

function comparableSetKey(evidence) {
  return `${normaliseComparableName(evidence.seriesName)}|${normaliseComparableName(evidence.setName)}`;
}

function comparableCardKey(evidence) {
  const number = normaliseCollectorNumber(evidence.collectorNumber);
  return `${number}|${normaliseComparableName(evidence.name)}`;
}

function pushMap(map, key, value) {
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

export function reconcilePokemonSetCollections(tcgdexSets, pokemonTcgSets) {
  if (!Array.isArray(tcgdexSets) || !Array.isArray(pokemonTcgSets)) {
    throw new TypeError('both set collections must be arrays');
  }

  const left = tcgdexSets.map((set) => adaptTcgdexSet(set));
  const right = pokemonTcgSets.map((set) => adaptPokemonTcgSet(set));
  const rightIndex = new Map();
  for (const evidence of right) pushMap(rightIndex, comparableSetKey(evidence), evidence);

  const matched = [];
  const conflicts = [];
  const unmatched = [];

  for (const evidence of left) {
    const candidates = rightIndex.get(comparableSetKey(evidence)) || [];
    if (candidates.length !== 1) {
      unmatched.push(Object.freeze({
        sourceName: evidence.sourceName,
        sourceRecordId: evidence.sourceRecordId,
        reason: candidates.length === 0 ? 'no_independent_set_candidate' : 'ambiguous_independent_set_candidates',
      }));
      continue;
    }

    const result = reconcileSetEvidence(evidence, candidates[0]);
    if (result.status === 'matched') matched.push(result);
    else if (result.status === 'conflict') conflicts.push(result);
    else unmatched.push(Object.freeze({
      sourceName: evidence.sourceName,
      sourceRecordId: evidence.sourceRecordId,
      reason: result.reason || 'set_not_reconciled',
    }));
  }

  return Object.freeze({
    matched: Object.freeze(matched),
    conflicts: Object.freeze(conflicts),
    unmatched: Object.freeze(unmatched),
  });
}

export function reconcilePokemonCardCollections({
  tcgdexCards,
  pokemonTcgCards,
  setMatch,
  sourceSeriesCode,
  languageCode = 'en',
}) {
  if (!Array.isArray(tcgdexCards) || !Array.isArray(pokemonTcgCards)) {
    throw new TypeError('both card collections must be arrays');
  }
  if (!setMatch || setMatch.status !== 'matched') {
    throw new TypeError('matched set crosswalk is required');
  }

  const right = pokemonTcgCards.map((card) => adaptPokemonTcgCardEvidence(card));
  const rightIndex = new Map();
  for (const evidence of right) pushMap(rightIndex, comparableCardKey(evidence), evidence);

  const matched = [];
  const conflicts = [];
  const quarantined = [];
  const unmatched = [];

  for (const rawCard of tcgdexCards) {
    const variantRecord = adaptTcgdexCard(rawCard, { sourceSeriesCode, languageCode });
    if (variantRecord.status === 'quarantined') {
      quarantined.push(Object.freeze({
        sourceName: variantRecord.baseEvidence.sourceName,
        sourceRecordId: variantRecord.baseEvidence.sourceRecordId,
        reason: variantRecord.reason,
      }));
      continue;
    }

    const candidates = rightIndex.get(comparableCardKey(variantRecord.baseEvidence)) || [];
    if (candidates.length !== 1) {
      unmatched.push(Object.freeze({
        sourceName: variantRecord.baseEvidence.sourceName,
        sourceRecordId: variantRecord.baseEvidence.sourceRecordId,
        reason: candidates.length === 0 ? 'no_independent_card_candidate' : 'ambiguous_independent_card_candidates',
      }));
      continue;
    }

    const result = reconcileCardEvidence(variantRecord, candidates[0], setMatch);
    if (result.status === 'matched') matched.push(result);
    else if (result.status === 'conflict') conflicts.push(result);
    else if (result.status === 'quarantined') quarantined.push(Object.freeze({
      sourceName: variantRecord.baseEvidence.sourceName,
      sourceRecordId: variantRecord.baseEvidence.sourceRecordId,
      reason: result.reason || 'card_quarantined',
    }));
    else unmatched.push(Object.freeze({
      sourceName: variantRecord.baseEvidence.sourceName,
      sourceRecordId: variantRecord.baseEvidence.sourceRecordId,
      reason: result.reason || 'card_not_reconciled',
    }));
  }

  return Object.freeze({
    matched: Object.freeze(matched),
    conflicts: Object.freeze(conflicts),
    quarantined: Object.freeze(quarantined),
    unmatched: Object.freeze(unmatched),
  });
}
