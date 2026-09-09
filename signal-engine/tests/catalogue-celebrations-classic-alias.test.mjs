import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePokemonCardCollections } from '../src/trader/catalogue/pipeline.mjs';

function setMatch({ tcgdexSetId = 'cel25cc', pokemonSetId = 'cel25c' } = {}) {
  return {
    status: 'matched',
    canonicalSeriesId: 'fdseries_test',
    canonicalSetId: 'fdset_test',
    tcgCode: 'pokemon',
    evidence: [
      { sourceName: 'tcgdex', sourceRecordId: tcgdexSetId },
      { sourceName: 'pokemontcg-api', sourceRecordId: pokemonSetId },
    ],
  };
}

function tcgdexCard({ id = 'cel25cc-CC001', localId = 'CC001', name = 'Blastoise' } = {}) {
  return {
    id,
    localId,
    name,
    category: 'Pokemon',
    rarity: 'Classic Collection',
    set: { id: 'cel25cc', name: 'Celebrations Classic Collection' },
    variants: { normal: false, reverse: false, holo: true, firstEdition: false },
  };
}

function pokemonCard({ id = 'cel25c-2_A', number = '2', name = 'Blastoise' } = {}) {
  return {
    id,
    number,
    name,
    supertype: 'Pokémon',
    rarity: 'Classic Collection',
    set: { id: 'cel25c', name: 'Celebrations Classic Collection', series: 'Sword & Shield' },
  };
}

test('Celebrations Classic reconciles exact unique name despite provider numbering convention', () => {
  const result = reconcilePokemonCardCollections({
    tcgdexCards: [tcgdexCard()],
    pokemonTcgCards: [pokemonCard()],
    setMatch: setMatch(),
    sourceSeriesCode: 'swsh',
  });

  assert.equal(result.matched.length, 1);
  assert.equal(result.unmatched.length, 0);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.matched[0].candidates[0].collectorNumber, 'cc001');
  assert.deepEqual(result.matched[0].acceptedDifferences, [{
    field: 'collectorNumber',
    left: 'CC001',
    right: '2',
    reason: 'celebrations_classic_source_numbering_convention',
  }]);
});

test('name-only alias stays fail-closed outside the verified Classic Collection set pair', () => {
  const result = reconcilePokemonCardCollections({
    tcgdexCards: [tcgdexCard()],
    pokemonTcgCards: [pokemonCard()],
    setMatch: setMatch({ tcgdexSetId: 'other', pokemonSetId: 'other2' }),
    sourceSeriesCode: 'swsh',
  });

  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched.length, 1);
});

test('Classic Collection name alias refuses ambiguous independent candidates', () => {
  const result = reconcilePokemonCardCollections({
    tcgdexCards: [tcgdexCard()],
    pokemonTcgCards: [pokemonCard(), pokemonCard({ id: 'cel25c-2_B', number: '99' })],
    setMatch: setMatch(),
    sourceSeriesCode: 'swsh',
  });

  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, 'ambiguous_independent_card_candidates');
});
