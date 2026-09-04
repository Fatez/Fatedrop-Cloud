import { createPokemonTcgClient, createTcgdexClient } from './source-clients.mjs';
import { buildReviewedPokemonSetCrosswalk } from './pokemon-set-crosswalk-reviewed.mjs';

async function main() {
  const asOfArg = process.argv.find((arg) => arg.startsWith('--as-of='));
  const asOf = asOfArg ? Date.parse(asOfArg.slice('--as-of='.length)) : Date.now();
  if (!Number.isFinite(asOf)) throw new TypeError('--as-of must be a valid date/time');

  const tcgdexClient = createTcgdexClient({ languageCode: 'en' });
  const pokemonTcgClient = createPokemonTcgClient({ apiKey: process.env.POKEMON_TCG_API_KEY || null });
  const plan = await buildReviewedPokemonSetCrosswalk({ tcgdexClient, pokemonTcgClient, asOf });

  const exclusionsByReason = {};
  for (const row of plan.excluded) {
    const reason = row.pulseEligibility.reason;
    exclusionsByReason[reason] = (exclusionsByReason[reason] || 0) + 1;
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: new Date(asOf).toISOString(),
    sourceCounts: plan.base.sourceCounts,
    baseCounts: plan.base.counts,
    reviewedCounts: plan.counts,
    universe: {
      totalMatched: plan.universe.total,
      eligible: plan.universe.eligible,
      excluded: plan.universe.excluded,
      categories: plan.universe.categories,
      exclusionsByReason,
    },
    reviewedAliasMatched: plan.reviewedAliasMatched.map((row) => ({
      tcgdexSetId: row.tcgdexSetId,
      pokemonTcgSetId: row.pokemonTcgSetId,
      setName: row.setMatch.setName,
      aliasReason: row.aliasReason,
    })),
    reviewedAliasRejected: plan.reviewedAliasRejected,
    sourceErrors: plan.sourceErrors,
    eligibleSets: plan.eligible,
    excludedSets: plan.excluded,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
