import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from './reconcile.mjs';

function setMatchHasEvidence(setMatch, sourceName, sourceRecordId) {
  return setMatch?.status === 'matched'
    && setMatch.evidence?.some((entry) => entry.sourceName === sourceName && entry.sourceRecordId === sourceRecordId) === true;
}

// PokemonTCG/pokemon-tcg-data currently stops SWSH Black Star Promos at SWSH298,
// while the official Pokemon card database publishes the final three English promos.
// Keep these as reviewed checklist membership evidence only. They do not create an
// exact finish identity and are never passed into reconcileCardEvidence.
const OFFICIAL_CHECKLIST_SUPPLEMENTS = Object.freeze([
  Object.freeze({
    sourceRecordId: 'swshp-SWSH299',
    name: 'Jirachi V',
    collectorNumber: 'SWSH299',
    officialRecordId: 'swshp/SWSH299',
    officialUrl: 'https://www.pokemon.com/uk/pokemon-tcg/pokemon-cards/series/swshp/SWSH299/',
  }),
  Object.freeze({
    sourceRecordId: 'swshp-SWSH300',
    name: 'Unown V',
    collectorNumber: 'SWSH300',
    officialRecordId: 'swshp/SWSH300',
    officialUrl: 'https://www.pokemon.com/uk/pokemon-tcg/pokemon-cards/series/swshp/SWSH300/',
  }),
  Object.freeze({
    sourceRecordId: 'swshp-SWSH301',
    name: 'Lugia V',
    collectorNumber: 'SWSH301',
    officialRecordId: 'swshp/SWSH301',
    officialUrl: 'https://www.pokemon.com/uk/pokemon-tcg/pokemon-cards/series/swshp/SWSH301/',
  }),
]);

export function reviewedOfficialChecklistPrinting(setMatch, baseEvidence) {
  if (!baseEvidence || baseEvidence.sourceName !== 'tcgdex' || baseEvidence.sourceSetCode !== 'swshp') return null;
  if (!setMatchHasEvidence(setMatch, 'tcgdex', 'swshp') || !setMatchHasEvidence(setMatch, 'pokemontcg-api', 'swshp')) return null;
  if (baseEvidence.tcgCode !== 'pokemon' || baseEvidence.languageCode !== 'en') return null;

  const supplement = OFFICIAL_CHECKLIST_SUPPLEMENTS.find((entry) =>
    entry.sourceRecordId === baseEvidence.sourceRecordId
      && normaliseComparableName(entry.name) === normaliseComparableName(baseEvidence.name)
      && normaliseCollectorNumber(entry.collectorNumber) === normaliseCollectorNumber(baseEvidence.collectorNumber));
  if (!supplement) return null;

  return Object.freeze({
    status: 'matched',
    tcgCode: setMatch.tcgCode,
    seriesCode: setMatch.canonicalSeriesId,
    setCode: setMatch.canonicalSetId,
    collectorNumber: baseEvidence.collectorNumber,
    printingCode: baseEvidence.printingCode,
    name: baseEvidence.name,
    rarity: baseEvidence.rarity ?? null,
    supertype: baseEvidence.supertype ?? null,
    subtypes: Object.freeze([]),
    nationalDexNumbers: Object.freeze([]),
    acceptedDifferences: Object.freeze([Object.freeze({
      field: 'cardMembership',
      left: baseEvidence.sourceRecordId,
      right: supplement.officialRecordId,
      reason: 'reviewed_official_pokemon_checklist_supplement',
    })]),
    verificationBasis: Object.freeze({
      kind: 'base_printing_tcgdex_official_pokemon',
      reviewedAt: '2026-09-11',
      sources: Object.freeze([
        Object.freeze({
          sourceName: 'tcgdex',
          sourceRecordId: baseEvidence.sourceRecordId,
          sourceUrl: baseEvidence.sourceUrl ?? null,
          languageCode: 'en',
        }),
        Object.freeze({
          sourceName: 'pokemon-official',
          sourceRecordId: supplement.officialRecordId,
          sourceUrl: supplement.officialUrl,
          languageCode: 'en',
        }),
      ]),
    }),
  });
}
