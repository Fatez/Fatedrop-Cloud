import assert from 'node:assert/strict';
import test from 'node:test';

import { cataloguePilotDefinition, selectCataloguePilot } from '../src/trader/catalogue/pilots.mjs';

function set(tcgdexSetId, setName) {
  return { tcgdexSetId, pokemonTcgSetId: `ptcg-${tcgdexSetId}`, setMatch: { canonicalSetId: `pokemon:${tcgdexSetId}`, setName } };
}

const completePlan = Object.freeze({
  matched: Object.freeze([
    set('sv04', 'Paradox Rift'),
    set('sv03', 'Obsidian Flames'),
    set('sv02', 'Paldea Evolved'),
    set('sv03.5', '151'),
    set('sv01', 'Scarlet & Violet'),
    set('other', 'Temporal Forces'),
  ]),
});

test('collector-v1 is exactly five English Pokemon sets', () => {
  const pilot = cataloguePilotDefinition('collector-v1');
  assert.equal(pilot.tcgCode, 'pokemon');
  assert.equal(pilot.languageCode, 'en');
  assert.deepEqual(pilot.setNames, ['Scarlet & Violet', 'Paldea Evolved', 'Obsidian Flames', '151', 'Paradox Rift']);
});

test('collector-v1 resolves five unique verified sets by exact normalized set name', () => {
  const selection = selectCataloguePilot(completePlan, 'collector-v1');
  assert.equal(selection.mode, 'pilot');
  assert.equal(selection.selected.length, 5);
  assert.deepEqual(selection.selected.map((row) => row.setMatch.setName), [
    'Scarlet & Violet',
    'Paldea Evolved',
    'Obsidian Flames',
    '151',
    'Paradox Rift',
  ]);
  assert.deepEqual(selection.crosswalk.matched, selection.selected);
});

test('collector pilot fails closed if any named set is absent', () => {
  const plan = { matched: completePlan.matched.filter((row) => row.setMatch.setName !== '151') };
  assert.throws(() => selectCataloguePilot(plan, 'collector-v1'), /missing: 151/i);
});

test('collector pilot fails closed if an exact set name is duplicated', () => {
  const plan = { matched: [...completePlan.matched, set('duplicate-sv02', 'Paldea Evolved')] };
  assert.throws(() => selectCataloguePilot(plan, 'collector-v1'), /ambiguous: Paldea Evolved/i);
});

test('collector pilot does not fuzzy-match near names', () => {
  const plan = {
    matched: completePlan.matched.map((row) => row.setMatch.setName === '151' ? set('sv03.5', 'Pokemon 151') : row),
  };
  assert.throws(() => selectCataloguePilot(plan, 'collector-v1'), /missing: 151/i);
});
