import { normaliseCollectorNumber } from '../card-identity.mjs';
import { adaptTcgdexCard, adaptTcgdexSet } from './tcgdex-adapter.mjs';
import { adaptPokemonTcgCardEvidence } from './pokemontcg-adapter.mjs';
import {
  allowsReviewedCardEvidenceAlias,
  normaliseComparableName,
  reconcileChecklistPrintingEvidence,
} from './reconcile.mjs';

function comparableCardKey(evidence) {
  const number = normaliseCollectorNumber(evidence.collectorNumber);
  return `${number}|${normaliseComparableName(evidence.name)}`;
}

function pushMap(map, key, value) {
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

function cardRefId(ref) {
  const id = String(ref?.id || ref || '').trim();
  return id || null;
}

function compactCandidate(evidence) {
  return {
    sourceName: evidence.sourceName,
    sourceRecordId: evidence.sourceRecordId,
    name: evidence.name,
    collectorNumber: evidence.collectorNumber,
  };
}

function nearbyCandidates(right, baseEvidence) {
  const wantedName = normaliseComparableName(baseEvidence.name);
  const wantedNumber = normaliseCollectorNumber(baseEvidence.collectorNumber);
  return {
    sameNameCandidates: right
      .filter((evidence) => normaliseComparableName(evidence.name) === wantedName)
      .map(compactCandidate),
    sameNumberCandidates: right
      .filter((evidence) => normaliseCollectorNumber(evidence.collectorNumber) === wantedNumber)
      .map(compactCandidate),
  };
}

// Diagnostic only. This mirrors the production candidate-selection rules closely
// enough to name checklist gaps without changing verification or persistence.
export async function diagnoseChecklistPrintingTail({
  tcgdexClient,
  pokemonTcgClient,
  pair,
  tcgdexConcurrency = 4,
} = {}) {
  if (!pair?.setMatch || pair.setMatch.status !== 'matched') throw new TypeError('matched pair is required');
  const rawTcgdexSet = await tcgdexClient.getSet(pair.tcgdexSetId);
  if (!Array.isArray(rawTcgdexSet?.cards)) throw new TypeError('TCGdex full set payload must contain cards[]');
  const refs = rawTcgdexSet.cards.map(cardRefId).filter(Boolean);
  const rawPokemonCards = await pokemonTcgClient.listCardsBySet(pair.pokemonTcgSetId);
  const tcgdexSet = adaptTcgdexSet(rawTcgdexSet);
  const right = rawPokemonCards.map((card) => adaptPokemonTcgCardEvidence(card));
  const rightIndex = new Map();
  for (const evidence of right) pushMap(rightIndex, comparableCardKey(evidence), evidence);

  const tcgdexCards = new Array(refs.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, tcgdexConcurrency), refs.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= refs.length) return;
      tcgdexCards[index] = await tcgdexClient.getCard(refs[index]);
    }
  });
  await Promise.all(workers);

  const unresolved = [];
  for (const rawCard of tcgdexCards) {
    const variantRecord = adaptTcgdexCard(rawCard, {
      sourceSeriesCode: tcgdexSet.sourceSeriesCode,
      languageCode: tcgdexSet.languageCode,
    });
    let candidates = rightIndex.get(comparableCardKey(variantRecord.baseEvidence)) || [];
    if (candidates.length === 0) {
      const reviewed = right.filter((evidence) => allowsReviewedCardEvidenceAlias(
        pair.setMatch,
        variantRecord.baseEvidence,
        evidence,
      ));
      if (reviewed.length) candidates = reviewed;
    }

    if (candidates.length !== 1) {
      unresolved.push({
        sourceRecordId: variantRecord.baseEvidence.sourceRecordId,
        name: variantRecord.baseEvidence.name,
        collectorNumber: variantRecord.baseEvidence.collectorNumber,
        reason: candidates.length === 0 ? 'no_independent_card_candidate' : 'ambiguous_independent_card_candidates',
        candidates: candidates.map(compactCandidate),
        ...nearbyCandidates(right, variantRecord.baseEvidence),
      });
      continue;
    }

    const checklist = reconcileChecklistPrintingEvidence(
      variantRecord.baseEvidence,
      candidates[0],
      pair.setMatch,
    );
    if (checklist.status !== 'matched') {
      unresolved.push({
        sourceRecordId: variantRecord.baseEvidence.sourceRecordId,
        name: variantRecord.baseEvidence.name,
        collectorNumber: variantRecord.baseEvidence.collectorNumber,
        reason: checklist.reason || checklist.status,
        field: checklist.field ?? null,
        left: checklist.left ?? null,
        right: checklist.right ?? null,
        candidates: candidates.map(compactCandidate),
        ...nearbyCandidates(right, variantRecord.baseEvidence),
      });
    }
  }
  return unresolved;
}
