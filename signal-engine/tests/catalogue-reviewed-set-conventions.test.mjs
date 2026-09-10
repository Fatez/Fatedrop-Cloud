import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSetEvidence } from '../src/trader/catalogue/reconcile.mjs';
import { buildVerifiedPokemonSetCrosswalk } from '../src/trader/catalogue/bulk-sync.mjs';

function evidence({ sourceName, sourceRecordId, setName, seriesName }) {
  return {
    sourceName,
    sourceRecordId,
    sourceSeriesCode: 'series',
    sourceUrl: `https://example.test/${sourceRecordId}`,
    languageCode: 'en',
    tcgCode: 'pokemon',
    setName,
    seriesName,
    releasedAt: Date.parse('2000-01-01T00:00:00Z'),
    printedTotal: 102,
    total: 102,
  };
}

test('reviewed exact series-name convention matches only the pinned source pair', () => {
  const left = evidence({ sourceName: 'tcgdex', sourceRecordId: 'bog', setName: 'Best of game', seriesName: 'E-Card' });
  const right = evidence({ sourceName: 'pokemontcg-api', sourceRecordId: 'bp', setName: 'Best of Game', seriesName: 'Other' });
  const result = reconcileSetEvidence(left, right);
  assert.equal(result.status, 'matched');
  assert.equal(result.acceptedDifferences.some((row) => row.reason === 'reviewed_source_series_name_convention'), true);

  const drifted = reconcileSetEvidence(left, { ...right, seriesName: 'EX' });
  assert.equal(drifted.status, 'conflict');
  assert.equal(drifted.field, 'seriesName');
});

test('reviewed exact set-name convention matches only the pinned values', () => {
  const left = evidence({ sourceName: 'tcgdex', sourceRecordId: 'hgss1', setName: 'HeartGold SoulSilver', seriesName: 'HeartGold & SoulSilver' });
  const right = evidence({ sourceName: 'pokemontcg-api', sourceRecordId: 'hgss1', setName: 'HeartGold & SoulSilver', seriesName: 'HeartGold & SoulSilver' });
  assert.equal(reconcileSetEvidence(left, right).status, 'matched');
  assert.equal(reconcileSetEvidence(left, { ...right, setName: 'HS Unlimited' }).status, 'conflict');
});

test('crosswalk uses reviewed source-id alias only when exact-name lookup has no candidate', async () => {
  const tcgdexSet = {
    id: 'hgss1',
    name: 'HeartGold SoulSilver',
    serie: { id: 'hgss', name: 'HeartGold & SoulSilver' },
    cardCount: { official: 123, total: 124 },
    releaseDate: '2010-02-10',
  };
  const pokemonSet = {
    id: 'hgss1',
    name: 'HeartGold & SoulSilver',
    series: 'HeartGold & SoulSilver',
    printedTotal: 123,
    total: 124,
    releaseDate: '2010/02/10',
  };
  const tcgdexClient = {
    async listSets() { return [{ id: 'hgss1', name: 'HeartGold SoulSilver' }]; },
    async getSeries() { return { sets: [] }; },
    async getSet(id) { assert.equal(id, 'hgss1'); return tcgdexSet; },
  };
  const pokemonTcgClient = {
    async listSets() { return [pokemonSet]; },
    async getSet(id) { assert.equal(id, 'hgss1'); return pokemonSet; },
  };
  const crosswalk = await buildVerifiedPokemonSetCrosswalk({ tcgdexClient, pokemonTcgClient });
  assert.equal(crosswalk.counts.matched, 1);
  assert.equal(crosswalk.counts.unmatchedTcgdex, 0);
  assert.equal(crosswalk.matched[0].tcgdexSetId, 'hgss1');
  assert.equal(crosswalk.matched[0].pokemonTcgSetId, 'hgss1');
});
