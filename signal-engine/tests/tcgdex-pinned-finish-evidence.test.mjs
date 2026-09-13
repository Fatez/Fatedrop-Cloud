import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTcgdexPinnedReviewedEvidence } from '../src/trader/value/tcgdex-pinned-finish-evidence-cli.mjs';

const REVISION = '5b6a2859f454972477a9953ffe5cb554d24c45e9';
const ROOT = '/repo';

function targetReport(overrides = {}) {
  return {
    productionWrites: false,
    tcgdexRevision: REVISION,
    targetCount: 1,
    blockedCount: 1120,
    blocked: [],
    targets: [{
      cardIdentityId: 'fdcard_test',
      variantCode: 'standard',
      language: 'en',
      edition: 'unspecified',
      name: 'Test Pokémon',
      collectorNumber: '080',
      tcgdexCardId: 'sm1-80',
      ...overrides,
    }],
  };
}

function repo(cardOverrides = {}) {
  return {
    sets: [{
      cards: [{
        tcgdexCardId: 'sm1-80',
        localId: '80',
        name: 'Test Pokémon',
        sourcePath: '/repo/data/Sun & Moon/sm1/80.ts',
        variants: [{ type: 'normal', subtype: null, foil: null, stamp: [], cardmarketProductId: null }],
        ...cardOverrides,
      }],
    }],
  };
}

test('pinned TCGdex explicit baseline variant becomes approved existence evidence', () => {
  const result = buildTcgdexPinnedReviewedEvidence(targetReport(), repo(), {
    revision: REVISION,
    repositoryRoot: ROOT,
    observedAt: 123,
  });
  assert.equal(result.productionWrites, false);
  assert.equal(result.priceWrites, false);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].verdict, 'exists');
  assert.equal(result.decisions[0].basis, 'exact_printing_checklist');
  assert.equal(result.decisions[0].finish, 'standard');
  assert.equal(result.provider, 'set_rule');
  assert.equal(result.counts.automatedNonexistence, 0);
});

test('subtype, foil or stamp variants are never collapsed into a baseline finish', () => {
  const result = buildTcgdexPinnedReviewedEvidence(targetReport(), repo({
    variants: [{ type: 'normal', subtype: 'firstEdition', foil: null, stamp: [], cardmarketProductId: 123 }],
  }), {
    revision: REVISION,
    repositoryRoot: ROOT,
    observedAt: 123,
  });
  assert.equal(result.decisions.length, 0);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0].reason, 'target_finish_not_explicit');
  assert.equal(result.counts.automatedNonexistence, 0);
});

test('exact name and collector identity are required before TCGdex evidence is accepted', () => {
  const nameMismatch = buildTcgdexPinnedReviewedEvidence(targetReport(), repo({ name: 'Different Pokémon' }), {
    revision: REVISION,
    repositoryRoot: ROOT,
    observedAt: 123,
  });
  assert.equal(nameMismatch.decisions.length, 0);
  assert.equal(nameMismatch.held[0].reason, 'pinned_tcgdex_name_mismatch');

  const collectorMismatch = buildTcgdexPinnedReviewedEvidence(targetReport(), repo({ localId: '81' }), {
    revision: REVISION,
    repositoryRoot: ROOT,
    observedAt: 123,
  });
  assert.equal(collectorMismatch.decisions.length, 0);
  assert.equal(collectorMismatch.held[0].reason, 'pinned_tcgdex_collector_mismatch');
});
