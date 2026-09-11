import { normaliseCollectorNumber } from '../card-identity.mjs';
import { selectChecklistArtworkEvidence } from './artwork.mjs';
import { adaptTcgdexCard, adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { adaptPokemonTcgCardEvidence, adaptPokemonTcgSet } from './pokemontcg-adapter.mjs';
import { reviewedChecklistCorroboration } from './checklist-reviewed-conventions.mjs';
import { reviewedOfficialChecklistPrinting } from './official-checklist-supplements.mjs';
import { allowsReviewedCardEvidenceAlias, normaliseComparableName, reconcileCardEvidence, reconcileChecklistPrintingEvidence, reconcileSetEvidence } from './reconcile.mjs';

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

function setMatchHasEvidence(setMatch, sourceName, sourceRecordId) {
  return setMatch.evidence?.some((entry) => entry.sourceName === sourceName && entry.sourceRecordId === sourceRecordId) === true;
}

function withChecklistArtwork(printing, ...evidences) {
  const artwork = selectChecklistArtworkEvidence(...evidences);
  if (!artwork) return printing;
  return Object.freeze({
    ...printing,
    thumbnailUrl: artwork.thumbnailUrl,
    artworkEvidence: artwork,
  });
}

function allowsCelebrationsClassicNameAlias(setMatch) {
  return setMatchHasEvidence(setMatch, 'tcgdex', 'cel25cc')
    && setMatchHasEvidence(setMatch, 'pokemontcg-api', 'cel25c');
}

function celebrationsChecklistCandidate(baseEvidence, candidate, enabled) {
  if (!enabled || !candidate) return null;
  if (normaliseComparableName(baseEvidence.name) !== normaliseComparableName(candidate.name)) return null;
  if (normaliseCollectorNumber(baseEvidence.collectorNumber) === normaliseCollectorNumber(candidate.collectorNumber)) return null;
  return Object.freeze({
    evidence: Object.freeze({ ...candidate, collectorNumber: baseEvidence.collectorNumber }),
    artworkEvidence: candidate,
    acceptedDifferences: Object.freeze([Object.freeze({
      field: 'collectorNumber',
      left: baseEvidence.collectorNumber,
      right: candidate.collectorNumber,
      reason: 'celebrations_classic_source_numbering_convention',
    })]),
  });
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

  const unsupportedPublisherEvidence = [];
  const right = pokemonTcgCards.flatMap((card) => {
    const evidence = adaptPokemonTcgCardEvidence(card);
    if (setMatchHasEvidence(setMatch, 'tcgdex', 'ex10')
      && setMatchHasEvidence(setMatch, 'pokemontcg-api', 'ex10')
      && card.set.id === 'ex10' && card.set.name === 'Unseen Forces'
      && card.set.series === 'EX' && card.name === 'Unown'
      && ((card.id === 'ex10-!' && card.number === '!')
        || (card.id === 'ex10-?' && card.number === '?'))) {
      unsupportedPublisherEvidence.push(Object.freeze({ ...evidence, reason: 'symbolic_collector_number_not_supported' }));
      return [];
    }
    return [evidence];
  });
  const rightIndex = new Map();
  const rightNameIndex = new Map();
  for (const evidence of right) {
    pushMap(rightIndex, comparableCardKey(evidence), evidence);
    pushMap(rightNameIndex, normaliseComparableName(evidence.name), evidence);
  }

  const matched = [];
  const checklistPrintings = [];
  const conflicts = [];
  const quarantined = [];
  const unmatched = [];
  const celebrationsClassicAlias = allowsCelebrationsClassicNameAlias(setMatch);

  for (const rawCard of tcgdexCards) {
    const variantRecord = adaptTcgdexCard(rawCard, { sourceSeriesCode, languageCode });
    let candidates = rightIndex.get(comparableCardKey(variantRecord.baseEvidence)) || [];
    if (candidates.length === 0) {
      const reviewedCandidates = right.filter((evidence) => allowsReviewedCardEvidenceAlias(setMatch, variantRecord.baseEvidence, evidence));
      if (reviewedCandidates.length) candidates = reviewedCandidates;
    }
    if (candidates.length === 0 && celebrationsClassicAlias) {
      candidates = rightNameIndex.get(normaliseComparableName(variantRecord.baseEvidence.name)) || [];
    }

    let checklistCandidate = candidates.length === 1
      ? Object.freeze({ evidence: candidates[0], artworkEvidence: candidates[0], acceptedDifferences: Object.freeze([]) })
      : null;
    if (checklistCandidate && celebrationsClassicAlias) {
      checklistCandidate = celebrationsChecklistCandidate(variantRecord.baseEvidence, candidates[0], true) || checklistCandidate;
    }
    if (!checklistCandidate) {
      const reviewedChecklistCandidates = right
        .map((evidence) => reviewedChecklistCorroboration(setMatch, variantRecord.baseEvidence, evidence))
        .filter(Boolean);
      if (reviewedChecklistCandidates.length === 1) {
        checklistCandidate = Object.freeze({
          ...reviewedChecklistCandidates[0],
          artworkEvidence: reviewedChecklistCandidates[0].evidence,
        });
      }
    }

    const officialChecklist = checklistCandidate
      ? null
      : reviewedOfficialChecklistPrinting(setMatch, variantRecord.baseEvidence);
    if (officialChecklist) {
      checklistPrintings.push(withChecklistArtwork(officialChecklist, officialChecklist, variantRecord.baseEvidence));
    } else if (checklistCandidate) {
      const checklist = reconcileChecklistPrintingEvidence(variantRecord.baseEvidence, checklistCandidate.evidence, setMatch);
      if (checklist.status === 'matched') {
        const reconciled = checklistCandidate.acceptedDifferences.length
          ? Object.freeze({
            ...checklist,
            acceptedDifferences: Object.freeze([
              ...(checklist.acceptedDifferences || []),
              ...checklistCandidate.acceptedDifferences,
            ]),
          })
          : checklist;
        checklistPrintings.push(withChecklistArtwork(
          reconciled,
          variantRecord.baseEvidence,
          checklistCandidate.artworkEvidence,
        ));
      }
    }

    if (variantRecord.status === 'quarantined') {
      quarantined.push(Object.freeze({
        sourceName: variantRecord.baseEvidence.sourceName,
        sourceRecordId: variantRecord.baseEvidence.sourceRecordId,
        reason: variantRecord.reason,
      }));
      continue;
    }

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
    ...(unsupportedPublisherEvidence.length ? { unsupportedPublisherEvidence: Object.freeze(unsupportedPublisherEvidence) } : {}),
    matched: Object.freeze(matched),
    checklistPrintings: Object.freeze(checklistPrintings),
    conflicts: Object.freeze(conflicts),
    quarantined: Object.freeze(quarantined),
    unmatched: Object.freeze(unmatched),
  });
}
