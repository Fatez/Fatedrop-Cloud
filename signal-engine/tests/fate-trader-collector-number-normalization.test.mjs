import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptTcgdexSet } from '../src/trader/catalogue/tcgdex-adapter.mjs';
import { adaptPokemonTcgSet } from '../src/trader/catalogue/pokemontcg-adapter.mjs';
import { reconcilePokemonCardCollections } from '../src/trader/catalogue/pipeline.mjs';
import { reconcileSetEvidence } from '../src/trader/catalogue/reconcile.mjs';

test('TCGdex zero-padded numeric collector numbers reconcile with unpadded Pokémon TCG API numbers', () => {
  const tcgdexSet = {
    id: 'sv-test',
    name: 'Test Set',
    serie: { id: 'sv', name: 'Scarlet & Violet' },
    cardCount: { official: 1, total: 1 },
    releaseDate: '2023-09-22',
  };
  const pokemonSet = {
    id: 'api-test',
    name: 'Test Set',
    series: 'Scarlet & Violet',
    printedTotal: 1,
    total: 1,
    releaseDate: '2023/09/22',
  };
  const setMatch = reconcileSetEvidence(adaptTcgdexSet(tcgdexSet), adaptPokemonTcgSet(pokemonSet));
  assert.equal(setMatch.status, 'matched');

  const result = reconcilePokemonCardCollections({
    tcgdexCards: [{
      id: 'sv-test-001',
      localId: '001',
      name: 'Bulbasaur',
      category: 'Pokemon',
      rarity: 'Common',
      set: { id: 'sv-test', name: 'Test Set' },
      variants: { firstEdition: false, normal: true, reverse: true, holo: false, wPromo: false },
    }],
    pokemonTcgCards: [{
      id: 'api-test-1',
      name: 'Bulbasaur',
      supertype: 'Pokémon',
      number: '1',
      rarity: 'Common',
      set: { id: 'api-test', name: 'Test Set', series: 'Scarlet & Violet' },
    }],
    setMatch,
    sourceSeriesCode: 'sv',
    languageCode: 'en',
  });

  assert.equal(result.matched.length, 1);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.unmatched.length, 0);
  assert.deepEqual(result.matched[0].candidates.map((candidate) => candidate.collectorNumber), ['1', '1']);
});
