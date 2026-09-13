import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPokemonTcgFinishEvidence,
  chooseCardmarketLane,
  normaliseCollectorNumber,
  tcgplayerFinishKeys,
} from '../src/trader/value/pokemontcg-finish-evidence-audit-cli.mjs';

const card = (prices) => ({ tcgplayer: { prices } });
const standardRow = { trend: 3.2, low: 2.9, avg: 3.1, avg1: 3.0, avg7: 3.2, avg30: 3.3 };
const holoRow = { 'trend-holo': 7.2, 'low-holo': 6.5, 'avg-holo': 7.0, 'avg1-holo': 7.1, 'avg7-holo': 7.2, 'avg30-holo': 7.4 };

test('normalises collector numbers without changing semantic suffixes', () => {
  assert.equal(normaliseCollectorNumber(' 067 '), '67');
  assert.equal(normaliseCollectorNumber('SWSH178'), 'SWSH178');
  assert.equal(normaliseCollectorNumber('GG026'), 'GG26');
});

test('uses only explicit TCGplayer finish keys as external finish evidence', () => {
  const evidenceCard = card({
    normal: { market: 1 },
    holofoil: { market: 2 },
    reverseHolofoil: { market: 3 },
    somethingElse: { market: 4 },
  });
  assert.deepEqual([...tcgplayerFinishKeys(evidenceCard)].sort(), ['holofoil', 'normal', 'reverseHolofoil']);
  assert.equal(assessPokemonTcgFinishEvidence(evidenceCard, 'standard').ok, true);
  assert.equal(assessPokemonTcgFinishEvidence(evidenceCard, 'holo').ok, true);
});

test('never infers a normal finish from rarity or another finish bucket', () => {
  const evidence = assessPokemonTcgFinishEvidence({ rarity: 'Rare', tcgplayer: { prices: { holofoil: { market: 2 } } } }, 'standard');
  assert.equal(evidence.ok, false);
  assert.equal(evidence.reason, 'external_target_finish_absent');
});

test('uses direct Cardmarket standard and holo lanes when present', () => {
  const standardEvidence = assessPokemonTcgFinishEvidence(card({ normal: { market: 1 } }), 'standard');
  const holoEvidence = assessPokemonTcgFinishEvidence(card({ holofoil: { market: 1 } }), 'holo');
  assert.deepEqual(chooseCardmarketLane(standardRow, 'standard', standardEvidence), {
    ok: true,
    providerLane: 'standard',
    basis: 'direct_cardmarket_finish_lane',
  });
  assert.deepEqual(chooseCardmarketLane(holoRow, 'holo', holoEvidence), {
    ok: true,
    providerLane: 'holo',
    basis: 'direct_cardmarket_finish_lane',
  });
});

test('allows Cardmarket base lane for holo only when external evidence proves holofoil and excludes normal', () => {
  const holoOnlyEvidence = assessPokemonTcgFinishEvidence(card({ holofoil: { market: 1 } }), 'holo');
  assert.deepEqual(chooseCardmarketLane(standardRow, 'holo', holoOnlyEvidence), {
    ok: true,
    providerLane: 'standard',
    basis: 'externally_proven_inherent_holo_base_lane',
  });

  const mixedEvidence = assessPokemonTcgFinishEvidence(card({ normal: { market: 1 }, holofoil: { market: 2 } }), 'holo');
  assert.deepEqual(chooseCardmarketLane(standardRow, 'holo', mixedEvidence), {
    ok: false,
    reason: 'no_unambiguous_cardmarket_price_lane',
  });
});

test('first-edition finish keys do not satisfy standard or holo targets', () => {
  const evidenceCard = card({
    '1stEditionNormal': { market: 1 },
    '1stEditionHolofoil': { market: 2 },
  });
  assert.equal(assessPokemonTcgFinishEvidence(evidenceCard, 'standard').ok, false);
  assert.equal(assessPokemonTcgFinishEvidence(evidenceCard, 'holo').ok, false);
});
