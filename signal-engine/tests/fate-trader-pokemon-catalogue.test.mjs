import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptTcgdexCard, adaptTcgdexSet } from '../src/trader/catalogue/tcgdex-adapter.mjs';
import { adaptPokemonTcgCardEvidence, adaptPokemonTcgSet } from '../src/trader/catalogue/pokemontcg-adapter.mjs';
import { reconcileSetEvidence } from '../src/trader/catalogue/reconcile.mjs';

const tcgdexSet = {
  id: 'swsh3',
  name: 'Darkness Ablaze',
  serie: { id: 'swsh', name: 'Sword & Shield' },
  cardCount: { official: 189, total: 201 },
  releaseDate: '2020-08-14',
};

const pokemonTcgSet = {
  id: 'swsh3',
  name: 'Darkness Ablaze',
  series: 'Sword & Shield',
  printedTotal: 189,
  total: 201,
  releaseDate: '2020/08/14',
};

test('independent set evidence reconciles into FateDrop-owned set identity', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const right = adaptPokemonTcgSet(pokemonTcgSet);
  const match = reconcileSetEvidence(left, right);

  assert.equal(match.status, 'matched');
  assert.match(match.canonicalSeriesId, /^fdseries_[a-f0-9]{24}$/);
  assert.match(match.canonicalSetId, /^fdset_[a-f0-9]{24}$/);
  assert.equal(match.evidence.length, 2);
});

test('set reconciliation fails closed on conflicting printed totals', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const right = adaptPokemonTcgSet({ ...pokemonTcgSet, printedTotal: 190 });
  const result = reconcileSetEvidence(left, right);

  assert.equal(result.status, 'conflict');
  assert.equal(result.field, 'printedTotal');
});

test('set reconciliation requires independent sources', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const result = reconcileSetEvidence(left, { ...left });

  assert.deepEqual(result, { status: 'insufficient', reason: 'independent_sources_required' });
});

test('TCGdex adapter expands explicit normal and reverse finishes into distinct staged identities', () => {
  const result = adaptTcgdexCard({
    id: 'swsh3-136',
    localId: '136',
    name: 'Furret',
    category: 'Pokemon',
    rarity: 'Uncommon',
    set: { id: 'swsh3', name: 'Darkness Ablaze' },
    variants: {
      firstEdition: false,
      normal: true,
      reverse: true,
      holo: false,
      wPromo: false,
    },
  }, { seriesCode: 'swsh', languageCode: 'en' });

  assert.equal(result.status, 'staged');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((item) => item.variantCode), ['standard', 'reverse-holo']);
  assert.notEqual(result.candidates[0].fateCardId, result.candidates[1].fateCardId);
});

test('TCGdex first-edition evidence is quarantined until edition/finish composition is modelled', () => {
  const result = adaptTcgdexCard({
    id: 'base1-4',
    localId: '4',
    name: 'Charizard',
    category: 'Pokemon',
    rarity: 'Rare Holo',
    set: { id: 'base1', name: 'Base Set' },
    variants: {
      firstEdition: true,
      normal: false,
      reverse: false,
      holo: true,
      wPromo: false,
    },
  }, { seriesCode: 'base', languageCode: 'en' });

  assert.equal(result.status, 'quarantined');
  assert.equal(result.reason, 'first_edition_variant_composition_not_supported');
  assert.equal(result.candidates.length, 0);
});

test('Pokémon TCG API card adapter explicitly records that it cannot prove finish variants', () => {
  const evidence = adaptPokemonTcgCardEvidence({
    id: 'swsh3-136',
    name: 'Furret',
    supertype: 'Pokémon',
    subtypes: ['Stage 1'],
    number: '136',
    rarity: 'Uncommon',
    nationalPokedexNumbers: [162],
    set: {
      id: 'swsh3',
      name: 'Darkness Ablaze',
      series: 'Sword & Shield',
    },
  });

  assert.equal(evidence.variantEvidenceAvailable, false);
  assert.equal(evidence.collectorNumber, '136');
  assert.equal(evidence.languageCode, 'en');
});
