import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePokemonCardCollections, reconcilePokemonSetCollections } from '../src/trader/catalogue/pipeline.mjs';
import { promoteMatchedCardEvidence } from '../src/trader/catalogue/verification.mjs';

const tcgdexSets = [{
  id: 'sv1-a',
  name: 'Example Set',
  serie: { id: 'sv', name: 'Scarlet & Violet' },
  cardCount: { official: 198, total: 210 },
  releaseDate: '2023-03-31',
}];

const pokemonSets = [{
  id: 'sv1-provider-b',
  name: 'Example Set',
  series: 'Scarlet & Violet',
  printedTotal: 198,
  total: 210,
  releaseDate: '2023/03/31',
}];

const tcgdexCards = [{
  id: 'sv1-a-001',
  localId: '001',
  name: 'Examplemon',
  category: 'Pokemon',
  rarity: 'Common',
  set: { id: 'sv1-a', name: 'Example Set' },
  variants: {
    firstEdition: false,
    normal: true,
    reverse: true,
    holo: false,
    wPromo: false,
  },
}];

const pokemonCards = [{
  id: 'sv1-provider-b-001',
  name: 'Examplemon',
  supertype: 'Pokémon',
  number: '001',
  rarity: 'Common',
  set: {
    id: 'sv1-provider-b',
    name: 'Example Set',
    series: 'Scarlet & Violet',
  },
}];

test('catalogue pipeline reconciles provider-owned set IDs before cards', () => {
  const sets = reconcilePokemonSetCollections(tcgdexSets, pokemonSets);
  assert.equal(sets.matched.length, 1);
  assert.equal(sets.conflicts.length, 0);

  const cards = reconcilePokemonCardCollections({
    tcgdexCards,
    pokemonTcgCards: pokemonCards,
    setMatch: sets.matched[0],
    sourceSeriesCode: 'sv',
  });

  assert.equal(cards.matched.length, 1);
  assert.equal(cards.conflicts.length, 0);
  assert.equal(cards.quarantined.length, 0);
  assert.equal(cards.matched[0].candidates.length, 2);
  assert.ok(cards.matched[0].candidates.every((item) => item.canonicalKey.includes(sets.matched[0].canonicalSetId)));
});

test('verification promotion is explicit and records its evidence basis', () => {
  const sets = reconcilePokemonSetCollections(tcgdexSets, pokemonSets);
  const cards = reconcilePokemonCardCollections({
    tcgdexCards,
    pokemonTcgCards: pokemonCards,
    setMatch: sets.matched[0],
    sourceSeriesCode: 'sv',
  });
  const verifiedAt = 1_777_000_000_000;
  const promotion = promoteMatchedCardEvidence(cards.matched[0], { verifiedAt });

  assert.equal(promotion.status, 'verified');
  assert.equal(promotion.identities.length, 2);
  assert.ok(promotion.identities.every((item) => item.verificationStatus === 'verified'));
  assert.ok(promotion.identities.every((item) => item.verifiedAt === verifiedAt));
  assert.ok(promotion.identities.every((item) => item.verificationBasis.baseIdentitySources.length === 2));
  assert.ok(promotion.identities.every((item) => item.verificationBasis.variantEvidenceExplicit === true));
});

test('verification promotion rejects a result that lacks independent corroboration', () => {
  const sets = reconcilePokemonSetCollections(tcgdexSets, pokemonSets);
  const cards = reconcilePokemonCardCollections({
    tcgdexCards,
    pokemonTcgCards: pokemonCards,
    setMatch: sets.matched[0],
    sourceSeriesCode: 'sv',
  });
  const invalid = {
    ...cards.matched[0],
    corroboration: {
      sourceName: cards.matched[0].candidates[0].sourceName,
      sourceRecordId: 'same-source',
    },
  };

  const promotion = promoteMatchedCardEvidence(invalid, { verifiedAt: 1_777_000_000_000 });
  assert.deepEqual(promotion, {
    status: 'rejected',
    reason: 'independent_sources_required',
    identities: [],
  });
});

test('ambiguous independent set candidates are not guessed through', () => {
  const result = reconcilePokemonSetCollections(tcgdexSets, [
    ...pokemonSets,
    { ...pokemonSets[0], id: 'duplicate-source-id' },
  ]);

  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, 'ambiguous_independent_set_candidates');
});
