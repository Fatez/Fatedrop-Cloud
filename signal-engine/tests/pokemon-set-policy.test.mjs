import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPokemonSetForPulse,
  getReviewedPokemonSetAlias,
  summarisePokemonPulseSetUniverse,
} from '../src/trader/catalogue/pokemon-set-policy.mjs';
import { buildReviewedPokemonSetCrosswalk } from '../src/trader/catalogue/pokemon-set-crosswalk-reviewed.mjs';

test('reviewed aliases are exact source-pair evidence, not fuzzy matching', () => {
  const alias = getReviewedPokemonSetAlias('base1', 'Base Set');
  assert.equal(alias?.pokemonTcgSetId, 'base1');
  assert.equal(alias?.pokemonTcgName, 'Base');
  assert.equal(getReviewedPokemonSetAlias('base1', 'Something Else'), null);
  assert.equal(getReviewedPokemonSetAlias('unknown', 'Base Set'), null);
});

test('Pulse set policy separates standard expansions from auxiliary groups', () => {
  const asOf = Date.parse('2026-09-04T00:00:00Z');
  assert.deepEqual(
    classifyPokemonSetForPulse({ tcgdexSetId: 'sv03.5', setName: '151', seriesName: 'Scarlet & Violet', releasedAt: Date.parse('2023-09-22T00:00:00Z') }, { asOf }),
    { category: 'expansion', eligibleForGlobalPulse: true, reason: 'released_physical_english_expansion' },
  );
  assert.equal(classifyPokemonSetForPulse({ tcgdexSetId: 'svp', setName: 'SVP Black Star Promos' }, { asOf }).eligibleForGlobalPulse, false);
  assert.equal(classifyPokemonSetForPulse({ tcgdexSetId: 'swsh9tg', setName: 'Brilliant Stars Trainer Gallery' }, { asOf }).category, 'subset');
  assert.equal(classifyPokemonSetForPulse({ tcgdexSetId: 'future', setName: 'Future Set', releasedAt: Date.parse('2026-10-01T00:00:00Z') }, { asOf }).category, 'unreleased');
});

test('universe summary records an inclusion or exclusion reason for every set', () => {
  const report = summarisePokemonPulseSetUniverse([
    { tcgdexSetId: 'sv03.5', setName: '151', releasedAt: Date.parse('2023-09-22T00:00:00Z') },
    { tcgdexSetId: 'swsh12.5gg', setName: 'Crown Zenith Galarian Gallery', releasedAt: Date.parse('2023-01-20T00:00:00Z') },
  ], { asOf: Date.parse('2026-09-04T00:00:00Z') });
  assert.equal(report.total, 2);
  assert.equal(report.eligible, 1);
  assert.equal(report.excluded, 1);
  assert.ok(report.sets.every((row) => typeof row.pulseEligibility.reason === 'string' && row.pulseEligibility.reason.length > 0));
});

test('reviewed crosswalk can recover Base Set without weakening exact source identity', async () => {
  const tcgdexSet = {
    id: 'base1',
    name: 'Base Set',
    serie: { id: 'base', name: 'Base' },
    cardCount: { official: 102, total: 102 },
    releaseDate: '1999-01-09',
  };
  const pokemonSet = {
    id: 'base1',
    name: 'Base',
    series: 'Base',
    releaseDate: '1999/01/09',
    printedTotal: 102,
    total: 102,
  };
  const tcgdexClient = {
    async listSets() { return [{ id: 'base1', name: 'Base Set' }]; },
    async getSeries() { return { sets: [] }; },
    async getSet(id) { assert.equal(id, 'base1'); return tcgdexSet; },
  };
  const pokemonTcgClient = {
    async listSets() { return [pokemonSet]; },
    async getSet(id) { assert.equal(id, 'base1'); return pokemonSet; },
  };

  const plan = await buildReviewedPokemonSetCrosswalk({
    tcgdexClient,
    pokemonTcgClient,
    asOf: Date.parse('2026-09-04T00:00:00Z'),
  });

  assert.equal(plan.counts.baseMatched, 0);
  assert.equal(plan.counts.reviewedAliasMatched, 1);
  assert.equal(plan.counts.totalMatched, 1);
  assert.equal(plan.matched[0].matchBasis, 'reviewed_alias');
  assert.equal(plan.matched[0].setMatch.setName, 'Base');
  assert.equal(plan.matched[0].setMatch.acceptedDifferences.at(-1).reason, 'reviewed_source_naming_alias');
  assert.equal(plan.counts.pulseEligible, 1);
});
