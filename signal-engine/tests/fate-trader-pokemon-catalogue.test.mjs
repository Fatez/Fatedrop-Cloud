import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptTcgdexCard, adaptTcgdexSet } from '../src/trader/catalogue/tcgdex-adapter.mjs';
import { adaptPokemonTcgCardEvidence, adaptPokemonTcgSet } from '../src/trader/catalogue/pokemontcg-adapter.mjs';
import { reconcileCardEvidence, reconcileSetEvidence } from '../src/trader/catalogue/reconcile.mjs';

const tcgdexSet = {
  id: 'swsh3',
  name: 'Darkness Ablaze',
  serie: { id: 'swsh', name: 'Sword & Shield' },
  cardCount: { official: 189, total: 201 },
  releaseDate: '2020-08-14',
};

const pokemonTcgSet = {
  id: 'swsh3-api',
  name: 'Darkness Ablaze',
  series: 'Sword & Shield',
  printedTotal: 189,
  total: 201,
  releaseDate: '2020/08/14',
};

function tcgdexFurret() {
  return adaptTcgdexCard({
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
  }, { sourceSeriesCode: 'swsh', languageCode: 'en' });
}

function pokemonTcgFurret() {
  return adaptPokemonTcgCardEvidence({
    id: 'swsh3-api-136',
    name: 'Furret',
    supertype: 'Pokémon',
    subtypes: ['Stage 1'],
    number: '136',
    rarity: 'Uncommon',
    nationalPokedexNumbers: [162],
    set: {
      id: 'swsh3-api',
      name: 'Darkness Ablaze',
      series: 'Sword & Shield',
    },
  });
}

test('independent set evidence reconciles into FateDrop-owned set identity', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const right = adaptPokemonTcgSet(pokemonTcgSet);
  const match = reconcileSetEvidence(left, right);

  assert.equal(match.status, 'matched');
  assert.match(match.canonicalSeriesId, /^fdseries_[a-f0-9]{24}$/);
  assert.match(match.canonicalSetId, /^fdset_[a-f0-9]{24}$/);
  assert.equal(match.evidence.length, 2);
  assert.deepEqual(match.acceptedDifferences, []);
});

test('canonical set identity does not depend on either upstream set ID', () => {
  const first = reconcileSetEvidence(
    adaptTcgdexSet(tcgdexSet),
    adaptPokemonTcgSet(pokemonTcgSet),
  );
  const second = reconcileSetEvidence(
    adaptTcgdexSet({ ...tcgdexSet, id: 'provider-a-different-id' }),
    adaptPokemonTcgSet({ ...pokemonTcgSet, id: 'provider-b-different-id' }),
  );

  assert.equal(first.status, 'matched');
  assert.equal(second.status, 'matched');
  assert.equal(first.canonicalSeriesId, second.canonicalSeriesId);
  assert.equal(first.canonicalSetId, second.canonicalSetId);
});

test('set reconciliation fails closed on conflicting printed totals', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const right = adaptPokemonTcgSet({ ...pokemonTcgSet, printedTotal: 190 });
  const result = reconcileSetEvidence(left, right);

  assert.equal(result.status, 'conflict');
  assert.equal(result.field, 'printedTotal');
});

test('set reconciliation records total-count convention differences without choosing a fake canonical total', () => {
  const left = adaptTcgdexSet({ ...tcgdexSet, cardCount: { official: 189, total: 201 } });
  const right = adaptPokemonTcgSet({ ...pokemonTcgSet, printedTotal: 189, total: 202 });
  const result = reconcileSetEvidence(left, right);

  assert.equal(result.status, 'matched');
  assert.equal(result.printedTotal, 189);
  assert.equal(result.total, null);
  assert.deepEqual(result.acceptedDifferences, [{
    field: 'total',
    left: 201,
    right: 202,
    reason: 'source_counting_convention',
  }]);
});

test('a total disagreement cannot replace a missing independent identity anchor', () => {
  const left = adaptTcgdexSet({ ...tcgdexSet, cardCount: { official: null, total: 201 } });
  const right = adaptPokemonTcgSet({ ...pokemonTcgSet, printedTotal: null, total: 202 });
  const result = reconcileSetEvidence(left, right);

  assert.deepEqual(result, { status: 'insufficient', reason: 'not_enough_set_anchors' });
});

test('set reconciliation still fails closed on release-date differences', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const right = adaptPokemonTcgSet({ ...pokemonTcgSet, releaseDate: '2020/08/15' });
  const result = reconcileSetEvidence(left, right);

  assert.equal(result.status, 'conflict');
  assert.equal(result.field, 'releasedAt');
});

test('set reconciliation still fails closed on series differences', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const right = adaptPokemonTcgSet({ ...pokemonTcgSet, series: 'Different Series' });
  const result = reconcileSetEvidence(left, right);

  assert.equal(result.status, 'conflict');
  assert.equal(result.field, 'seriesName');
});

test('set reconciliation requires independent sources', () => {
  const left = adaptTcgdexSet(tcgdexSet);
  const result = reconcileSetEvidence(left, { ...left });

  assert.deepEqual(result, { status: 'insufficient', reason: 'independent_sources_required' });
});

test('TCGdex adapter emits source evidence and explicit finishes without creating FateDrop IDs', () => {
  const result = tcgdexFurret();

  assert.equal(result.status, 'staged');
  assert.equal(result.baseEvidence.sourceSetCode, 'swsh3');
  assert.equal(result.baseEvidence.fateCardId, undefined);
  assert.equal(result.variantEvidence.length, 2);
  assert.deepEqual(result.variantEvidence.map((item) => item.variantCode), ['standard', 'reverse-holo']);
});

test('card reconciliation creates canonical staged card identities only after set crosswalk and independent card corroboration', () => {
  const setMatch = reconcileSetEvidence(adaptTcgdexSet(tcgdexSet), adaptPokemonTcgSet(pokemonTcgSet));
  const result = reconcileCardEvidence(tcgdexFurret(), pokemonTcgFurret(), setMatch);

  assert.equal(result.status, 'matched');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((item) => item.variantCode), ['standard', 'reverse-holo']);
  assert.ok(result.candidates.every((item) => item.verificationStatus === 'staged'));
  assert.ok(result.candidates.every((item) => item.canonicalKey.includes(setMatch.canonicalSetId)));
  assert.ok(result.candidates.every((item) => !item.canonicalKey.includes('swsh3-api')));
  assert.notEqual(result.candidates[0].fateCardId, result.candidates[1].fateCardId);
});

test('card reconciliation fails closed when independent sources disagree on card name', () => {
  const setMatch = reconcileSetEvidence(adaptTcgdexSet(tcgdexSet), adaptPokemonTcgSet(pokemonTcgSet));
  const corroborating = { ...pokemonTcgFurret(), name: 'Different Card' };
  const result = reconcileCardEvidence(tcgdexFurret(), corroborating, setMatch);

  assert.equal(result.status, 'conflict');
  assert.equal(result.field, 'cardName');
});

test('card reconciliation fails closed when collector numbers disagree', () => {
  const setMatch = reconcileSetEvidence(adaptTcgdexSet(tcgdexSet), adaptPokemonTcgSet(pokemonTcgSet));
  const corroborating = { ...pokemonTcgFurret(), collectorNumber: '137' };
  const result = reconcileCardEvidence(tcgdexFurret(), corroborating, setMatch);

  assert.equal(result.status, 'conflict');
  assert.equal(result.field, 'collectorNumber');
});

test('card reconciliation rejects card evidence from a set not present in the matched crosswalk', () => {
  const setMatch = reconcileSetEvidence(adaptTcgdexSet(tcgdexSet), adaptPokemonTcgSet(pokemonTcgSet));
  const wrongSetCard = { ...pokemonTcgFurret(), sourceSetCode: 'other-set' };
  const result = reconcileCardEvidence(tcgdexFurret(), wrongSetCard, setMatch);

  assert.equal(result.status, 'conflict');
  assert.equal(result.field, 'corroboratingSourceSet');
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
  }, { sourceSeriesCode: 'base', languageCode: 'en' });

  assert.equal(result.status, 'quarantined');
  assert.equal(result.reason, 'first_edition_variant_composition_not_supported');
  assert.equal(result.variantEvidence.length, 0);
});

test('Pokémon TCG API card adapter explicitly records that it cannot prove finish variants', () => {
  const evidence = pokemonTcgFurret();

  assert.equal(evidence.variantEvidenceAvailable, false);
  assert.equal(evidence.collectorNumber, '136');
  assert.equal(evidence.languageCode, 'en');
});
