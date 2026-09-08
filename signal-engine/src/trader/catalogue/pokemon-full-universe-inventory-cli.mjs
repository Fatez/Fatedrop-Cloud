import { loadTcgdexRepositoryEvidence } from '../value/tcgdex-repository-cardmarket-evidence.mjs';
import { classifyPokemonSetForPulse } from './pokemon-set-policy.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

const repo = argValue('tcgdex-repo');
if (!repo) throw new Error('--tcgdex-repo=<path> is required');
const revision = argValue('tcgdex-revision') || 'unknown';
const asOf = argValue('as-of') ? Date.parse(argValue('as-of')) : Date.now();

const evidence = loadTcgdexRepositoryEvidence(repo, { includeCards: true });
const sets = evidence.sets.map((set) => {
  const pulse = classifyPokemonSetForPulse({
    tcgdexSetId: set.tcgdexSetId,
    setName: set.setName,
    seriesName: set.seriesName,
    releasedAt: set.releaseDate ? Date.parse(set.releaseDate) : null,
  }, { asOf });
  const variants = set.cards.reduce((sum, card) => sum + card.variants.length, 0);
  const variantsWithCardmarketId = set.cards.reduce((sum, card) => sum + card.variants.filter((variant) => Number.isSafeInteger(Number(variant.cardmarketProductId)) && Number(variant.cardmarketProductId) > 0).length, 0);
  return {
    tcgdexSetId: set.tcgdexSetId,
    setName: set.setName,
    seriesName: set.seriesName,
    releaseDate: set.releaseDate,
    officialCardCount: set.officialCardCount,
    cards: set.cards.length,
    variants,
    variantsWithCardmarketId,
    cardmarketExpansionId: set.cardmarketExpansionId,
    pulseCategory: pulse.category,
    pulseEligible: pulse.eligibleForGlobalPulse,
    pulseReason: pulse.reason,
  };
});

const totals = sets.reduce((acc, set) => {
  acc.cards += set.cards;
  acc.variants += set.variants;
  acc.variantsWithCardmarketId += set.variantsWithCardmarketId;
  if (set.cardmarketExpansionId) acc.setsWithCardmarketExpansionId += 1;
  if (set.cards === 0) acc.setsWithZeroCards += 1;
  return acc;
}, { cards: 0, variants: 0, variantsWithCardmarketId: 0, setsWithCardmarketExpansionId: 0, setsWithZeroCards: 0 });

const report = {
  generatedAt: new Date().toISOString(),
  source: {
    repository: 'tcgdex/cards-database',
    revision,
    language: 'en',
  },
  summary: {
    sets: sets.length,
    cards: totals.cards,
    variants: totals.variants,
    variantsWithCardmarketId: totals.variantsWithCardmarketId,
    setsWithCardmarketExpansionId: totals.setsWithCardmarketExpansionId,
    setsWithZeroCards: totals.setsWithZeroCards,
    pulseEligibleSets: sets.filter((set) => set.pulseEligible).length,
    pulseExcludedSets: sets.filter((set) => !set.pulseEligible).length,
  },
  setCategories: countBy(sets, (set) => set.pulseCategory),
  series: countBy(sets, (set) => set.seriesName),
  sets,
  safety: {
    binderUniverseIncludesPulseExcludedSets: true,
    noCardsDiscardedForPulsePolicy: true,
    noFuzzyMatching: true,
    evidenceOnly: true,
  },
};

console.log(JSON.stringify(report, null, 2));
