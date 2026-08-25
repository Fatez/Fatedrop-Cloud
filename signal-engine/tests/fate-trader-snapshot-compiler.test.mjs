import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePokemonCatalogueSnapshots } from '../src/trader/catalogue/snapshot-compiler.mjs';

function fixtures({ omitSecondPokemonCard = false } = {}) {
  const tcgdexSet = {
    id: 'svtest',
    name: 'Test Set',
    serie: { id: 'sv', name: 'Scarlet & Violet' },
    cardCount: { official: 2, total: 2 },
    releaseDate: '2024-01-01',
    cards: [
      { id: 'svtest-001', localId: '001', name: 'Bulbasaur' },
      { id: 'svtest-002', localId: '002', name: 'Ivysaur' },
    ],
  };
  const tcgdexSnapshot = {
    meta: { source: 'tcgdex/cards-database', commit: 'tcgdex-commit', language: 'en' },
    series: {
      sv: { id: 'sv', name: 'Scarlet & Violet', sets: [{ id: 'svtest', name: 'Test Set' }] },
      tcgp: { id: 'tcgp', name: 'Pokémon TCG Pocket', sets: [] },
    },
    sets: { svtest: tcgdexSet },
    cards: {
      'svtest-001': {
        id: 'svtest-001', localId: '001', name: 'Bulbasaur', rarity: 'Common', category: 'Pokemon',
        set: { id: 'svtest', name: 'Test Set' },
        variants: { firstEdition: false, holo: false, normal: true, reverse: true, wPromo: false },
      },
      'svtest-002': {
        id: 'svtest-002', localId: '002', name: 'Ivysaur', rarity: 'Uncommon', category: 'Pokemon',
        set: { id: 'svtest', name: 'Test Set' },
        variants: { firstEdition: false, holo: false, normal: true, reverse: false, wPromo: false },
      },
    },
  };

  const pokemonSet = {
    id: 'sv-test', name: 'Test Set', series: 'Scarlet & Violet', printedTotal: 2, total: 2, releaseDate: '2024/01/01',
  };
  const pokemonCards = [
    {
      id: 'sv-test-1', name: 'Bulbasaur', number: '1', rarity: 'Common', supertype: 'Pokémon',
      set: { id: 'sv-test', name: 'Test Set', series: 'Scarlet & Violet' },
    },
    {
      id: 'sv-test-2', name: 'Ivysaur', number: '2', rarity: 'Uncommon', supertype: 'Pokémon',
      set: { id: 'sv-test', name: 'Test Set', series: 'Scarlet & Violet' },
    },
  ];
  const pokemonTcgSnapshot = {
    meta: { source: 'PokemonTCG/pokemon-tcg-data', commit: 'pokemon-commit', language: 'en' },
    sets: [pokemonSet],
    cardsBySet: { 'sv-test': omitSecondPokemonCard ? pokemonCards.slice(0, 1) : pokemonCards },
  };
  return { tcgdexSnapshot, pokemonTcgSnapshot };
}

test('snapshot compiler promotes only a completely reconciled set', async () => {
  const artifact = await compilePokemonCatalogueSnapshots({ ...fixtures(), verifiedAt: 1_700_000_000_000 });

  assert.equal(artifact.compilation.verifiedSetCount, 1);
  assert.equal(artifact.compilation.rejectedSetCount, 0);
  assert.equal(artifact.counts.sets, 1);
  assert.equal(artifact.counts.printings, 2);
  assert.equal(artifact.counts.cardIdentities, 3);
  assert.equal(artifact.compilation.verifiedSets[0].matchedCardRecords, 2);
  assert.equal(artifact.compilation.verifiedSets[0].unmatched, 0);
  assert.equal(artifact.sources.tcgdex.commit, 'tcgdex-commit');
  assert.equal(artifact.sources.pokemonTcg.commit, 'pokemon-commit');

  const numbers = new Set(artifact.rows.cardIdentities.map((card) => card.collectorNumber));
  assert.deepEqual(numbers, new Set(['1', '2']));
  assert.deepEqual(
    new Set(artifact.rows.setSourceMappings.map((row) => row.sourceVersion)),
    new Set(['tcgdex-commit', 'pokemon-commit']),
  );
  assert.ok(artifact.rows.cardSourceMappings.every((row) => row.sourceVersion === 'tcgdex-commit'));
  assert.deepEqual(
    new Set(artifact.rows.cardProvenance.map((row) => row.evidenceJson.sourceCommit)),
    new Set(['tcgdex-commit', 'pokemon-commit']),
  );
});

test('snapshot compiler rejects an incomplete set without leaking partial catalogue rows', async () => {
  const artifact = await compilePokemonCatalogueSnapshots({
    ...fixtures({ omitSecondPokemonCard: true }),
    verifiedAt: 1_700_000_000_000,
  });

  assert.equal(artifact.compilation.verifiedSetCount, 0);
  assert.equal(artifact.compilation.rejectedSetCount, 1);
  assert.equal(artifact.counts.sets, 0);
  assert.equal(artifact.counts.printings, 0);
  assert.equal(artifact.counts.cardIdentities, 0);
  assert.ok(artifact.compilation.rejectedSets[0].reasons.includes('source_card_count_mismatch'));
  assert.ok(artifact.compilation.rejectedSets[0].reasons.includes('not_all_source_cards_reconciled'));
});
