import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVerifiedSetCrosswalk } from '../src/trader/catalogue/selection.mjs';

function pair(tcgdexSetId, setName) {
  return Object.freeze({
    tcgdexSetId,
    pokemonTcgSetId: `api-${tcgdexSetId}`,
    setMatch: Object.freeze({ canonicalSetId: `fdset_${tcgdexSetId}`, setName }),
  });
}

function plan() {
  return Object.freeze({
    counts: Object.freeze({ matched: 3, rejected: 0 }),
    matched: Object.freeze([
      pair('sv03.5', '151'),
      pair('sv04.5', 'Paldean Fates'),
      pair('sv08.5', 'Prismatic Evolutions'),
    ]),
    rejected: Object.freeze([]),
  });
}

test('empty selection preserves the complete verified crosswalk', () => {
  const source = plan();
  const result = selectVerifiedSetCrosswalk(source, []);

  assert.equal(result.mode, 'all');
  assert.equal(result.crosswalk, source);
  assert.equal(result.selected, source.matched);
});

test('targeted selection keeps only explicitly requested verified set IDs in operator order', () => {
  const source = plan();
  const result = selectVerifiedSetCrosswalk(source, ['sv08.5', 'sv03.5']);

  assert.equal(result.mode, 'targeted');
  assert.deepEqual(result.requestedSetIds, ['sv08.5', 'sv03.5']);
  assert.deepEqual(result.selected.map((entry) => entry.tcgdexSetId), ['sv08.5', 'sv03.5']);
  assert.deepEqual(result.crosswalk.matched.map((entry) => entry.tcgdexSetId), ['sv08.5', 'sv03.5']);
  assert.equal(result.crosswalk.counts.matched, 3);
});

test('targeted selection refuses any set that is not already in the verified crosswalk', () => {
  assert.throws(
    () => selectVerifiedSetCrosswalk(plan(), ['sv03.5', 'unknown-set']),
    /Requested catalogue set is not in the verified crosswalk: unknown-set/,
  );
});

test('targeted selection refuses duplicate set IDs', () => {
  assert.throws(
    () => selectVerifiedSetCrosswalk(plan(), ['sv03.5', 'sv03.5']),
    /Requested catalogue set IDs must be unique/,
  );
});
