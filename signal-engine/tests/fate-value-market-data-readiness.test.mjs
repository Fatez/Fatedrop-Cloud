import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMarketDataReadinessReport } from '../src/trader/value/market-data-readiness.mjs';

function makeState({ includeHistory = true } = {}) {
  const state = {
    traderCatalogue: {
      tcgs: {
        pkmn: { id: 'pkmn', code: 'pokemon' },
        op: { id: 'op', code: 'one-piece' },
      },
      series: {
        sv: { id: 'sv', tcgId: 'pkmn', code: 'scarlet-violet' },
        opc: { id: 'opc', tcgId: 'op', code: 'one-piece-card-game' },
      },
      sets: {
        sv08: { id: 'sv08', tcgId: 'pkmn', seriesId: 'sv', code: 'sv08' },
        op09: { id: 'op09', tcgId: 'op', seriesId: 'opc', code: 'op09' },
      },
      cards: {
        p1: { id: 'p1', tcgId: 'pkmn', seriesId: 'sv', setId: 'sv08', verificationStatus: 'verified' },
        p2: { id: 'p2', tcgId: 'pkmn', seriesId: 'sv', setId: 'sv08', verificationStatus: 'verified' },
        op1: { id: 'op1', tcgId: 'op', seriesId: 'opc', setId: 'op09', verificationStatus: 'verified' },
        staged: { id: 'staged', tcgId: 'pkmn', seriesId: 'sv', setId: 'sv08', verificationStatus: 'staged' },
      },
      cardSourceMappings: {
        p1: { id: 'map_p1', cardIdentityId: 'p1', sourceName: 'cardmarket', sourceRecordId: '1', sourceVariantKey: 'normal' },
        op1: { id: 'map_op1', cardIdentityId: 'op1', sourceName: 'cardmarket', sourceRecordId: '2', sourceVariantKey: 'normal' },
        other: { id: 'map_other', cardIdentityId: 'p2', sourceName: 'other-source', sourceRecordId: '3', sourceVariantKey: 'normal' },
      },
    },
  };

  if (includeHistory) {
    const observation = (id, cardIdentityId, marketDay) => ({
      id,
      cardIdentityId,
      sourceName: 'cardmarket',
      sourceVariantKey: 'normal',
      marketSegmentKey: 'standard',
      conditionCode: 'unspecified',
      currencyCode: 'EUR',
      marketDay,
    });
    state.fateValueLab = {
      ingestRuns: {},
      rejections: {},
      observations: {
        p1_now: observation('p1_now', 'p1', '2026-09-03'),
        op1_now: observation('op1_now', 'op1', '2026-09-03'),
        p1_d1: observation('p1_d1', 'p1', '2026-09-02'),
        p1_d7: observation('p1_d7', 'p1', '2026-08-27'),
        op1_d7: observation('op1_d7', 'op1', '2026-08-27'),
        p1_d30: observation('p1_d30', 'p1', '2026-08-04'),
        foreign: { ...observation('foreign', 'p2', '2026-09-03'), sourceName: 'other-source' },
      },
    };
  }

  return state;
}

function store(state) {
  return { read: async () => state };
}

test('reports verified catalogue and exact Cardmarket mapping coverage by game and set', async () => {
  const report = await buildMarketDataReadinessReport(store(makeState()));

  assert.equal(report.schemaVersion, 'market-data-readiness:1a2');
  assert.equal(report.canonical.verifiedCards, 3);
  assert.equal(report.canonical.mappedCards, 2);
  assert.equal(report.canonical.unmappedVerifiedCards, 1);
  assert.equal(report.canonical.mappingCoveragePct, 66.666667);
  assert.equal(report.canonical.verifiedTcgs, 2);
  assert.equal(report.canonical.verifiedSets, 2);

  const pokemon = report.byTcg.find((item) => item.key === 'pokemon');
  const onePiece = report.byTcg.find((item) => item.key === 'one-piece');
  assert.deepEqual(pokemon, { key: 'pokemon', verifiedCards: 2, mappedCards: 1, mappingCoveragePct: 50 });
  assert.deepEqual(onePiece, { key: 'one-piece', verifiedCards: 1, mappedCards: 1, mappingCoveragePct: 100 });
  assert.ok(report.bySet.some((item) => item.key === 'pokemon|sv08'));
  assert.ok(report.bySet.some((item) => item.key === 'one-piece|op09'));
});

test('measures exact 1d, 7d and 30d lane history coverage from one anchor day', async () => {
  const report = await buildMarketDataReadinessReport(store(makeState()));

  assert.equal(report.history.observations, 6);
  assert.equal(report.history.observedCards, 2);
  assert.equal(report.history.distinctMarketDays, 4);
  assert.equal(report.history.latestMarketDay, '2026-09-03');
  assert.equal(report.history.currentLaneCount, 2);
  assert.deepEqual(report.history.exactBaselineCoverage.d1, {
    baselineMarketDay: '2026-09-02', eligibleLanes: 2, coveredLanes: 1, coveragePct: 50,
  });
  assert.deepEqual(report.history.exactBaselineCoverage.d7, {
    baselineMarketDay: '2026-08-27', eligibleLanes: 2, coveredLanes: 2, coveragePct: 100,
  });
  assert.deepEqual(report.history.exactBaselineCoverage.d30, {
    baselineMarketDay: '2026-08-04', eligibleLanes: 2, coveredLanes: 1, coveragePct: 50,
  });
  assert.ok(report.issues.includes('d1_baseline_coverage_incomplete'));
  assert.ok(!report.issues.includes('d7_baseline_coverage_incomplete'));
  assert.ok(report.issues.includes('d30_baseline_coverage_incomplete'));
});

test('missing market history is explicit and never becomes synthetic zero coverage', async () => {
  const report = await buildMarketDataReadinessReport(store(makeState({ includeHistory: false })));

  assert.equal(report.marketHistorySchemaAvailable, false);
  assert.equal(report.history.observations, 0);
  assert.equal(report.history.latestMarketDay, null);
  assert.equal(report.history.exactBaselineCoverage.d7.coveragePct, null);
  assert.ok(report.issues.includes('market_history_schema_missing'));
  assert.ok(!report.issues.includes('no_market_history'));
});

test('staged cards and other providers do not inflate Cardmarket readiness', async () => {
  const state = makeState();
  state.traderCatalogue.cardSourceMappings.staged = {
    id: 'map_staged',
    cardIdentityId: 'staged',
    sourceName: 'cardmarket',
    sourceRecordId: '4',
    sourceVariantKey: 'normal',
  };
  state.fateValueLab.observations.staged = {
    id: 'obs_staged',
    cardIdentityId: 'staged',
    sourceName: 'cardmarket',
    sourceVariantKey: 'normal',
    marketSegmentKey: 'standard',
    conditionCode: 'unspecified',
    currencyCode: 'EUR',
    marketDay: '2026-09-03',
  };

  const report = await buildMarketDataReadinessReport(store(state));
  assert.equal(report.canonical.verifiedCards, 3);
  assert.equal(report.canonical.mappedCards, 2);
  assert.equal(report.history.observedCards, 2);
  assert.equal(report.history.currentLaneCount, 2);
});
