import test from 'node:test';
import assert from 'node:assert/strict';

import { runCardmarketPokemonMarketCycle } from '../src/trader/value/cardmarket-market-cycle.mjs';

const FETCHED_AT = Date.parse('2026-09-03T10:00:00.000Z');

function stateWithMapping({ mapped = true } = {}) {
  return {
    traderCatalogue: {
      tcgs: { pokemon: { id: 'pokemon', code: 'pokemon' } },
      series: { sv: { id: 'sv', tcgId: 'pokemon', code: 'scarlet-violet' } },
      sets: { sv08: { id: 'sv08', tcgId: 'pokemon', seriesId: 'sv', code: 'sv08' } },
      cards: {
        card1: {
          id: 'card1', tcgId: 'pokemon', seriesId: 'sv', setId: 'sv08',
          verificationStatus: 'verified',
        },
      },
      cardSourceMappings: mapped ? {
        map1: {
          id: 'map1',
          cardIdentityId: 'card1',
          sourceName: 'cardmarket',
          sourceRecordId: '668227',
          sourceVariantKey: 'normal',
        },
      } : {},
    },
  };
}

function store(initial) {
  const state = initial;
  return {
    read: async () => state,
    mutate: async (fn) => fn(state),
    snapshot: () => structuredClone(state),
  };
}

function priceGuidePayload() {
  return {
    version: 1,
    createdAt: '2026-09-03T09:00:00+0000',
    priceGuides: [{
      idProduct: 668227,
      idCategory: 51,
      avg: 10,
      low: 8,
      trend: 11,
      avg1: 10.5,
      avg7: 9.5,
      avg30: 9,
      'avg-holo': null,
      'low-holo': null,
      'trend-holo': 0,
      'avg1-holo': null,
      'avg7-holo': null,
      'avg30-holo': null,
    }],
  };
}

function fetchImpl(payload = priceGuidePayload()) {
  return async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag: '"market-cycle-test"',
      'last-modified': 'Thu, 03 Sep 2026 09:00:00 GMT',
    },
  });
}

test('market cycle defaults to dry-run and cannot mutate market history', async () => {
  const valueStore = store(stateWithMapping());
  const report = await runCardmarketPokemonMarketCycle({
    store: valueStore,
    fetchImpl: fetchImpl(),
    fetchedAt: FETCHED_AT,
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.persistenceAuthorized, false);
  assert.equal(report.recordsAccepted, 1);
  assert.equal(report.recordsRejected, 0);
  assert.equal(report.persistence, null);
  assert.match(report.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(valueStore.snapshot().fateValueLab, undefined);
  assert.equal(report.readiness.marketHistorySchemaAvailable, false);
});

test('explicit persist mode stores the exact fetched provider snapshot once', async () => {
  const valueStore = store(stateWithMapping());
  const first = await runCardmarketPokemonMarketCycle({
    store: valueStore,
    mode: 'persist',
    fetchImpl: fetchImpl(),
    fetchedAt: FETCHED_AT,
  });
  const replay = await runCardmarketPokemonMarketCycle({
    store: valueStore,
    mode: 'persist',
    fetchImpl: fetchImpl(),
    fetchedAt: FETCHED_AT + 60_000,
    observedAt: FETCHED_AT + 60_000,
  });

  assert.equal(first.persistenceAuthorized, true);
  assert.equal(first.persistence.insertedObservations, 1);
  assert.equal(replay.persistence.insertedObservations, 0);
  assert.equal(replay.persistence.duplicateObservations, 1);
  assert.equal(first.readiness.marketHistorySchemaAvailable, true);
  assert.equal(first.readiness.history.observations, 1);
  assert.equal(Object.keys(valueStore.snapshot().fateValueLab.observations).length, 1);
});

test('unmapped source evidence stays a rejection even in explicit persist mode', async () => {
  const valueStore = store(stateWithMapping({ mapped: false }));
  const report = await runCardmarketPokemonMarketCycle({
    store: valueStore,
    mode: 'persist',
    fetchImpl: fetchImpl(),
    fetchedAt: FETCHED_AT,
  });

  assert.equal(report.recordsAccepted, 0);
  assert.equal(report.recordsRejected, 1);
  assert.equal(report.persistence.insertedObservations, 0);
  assert.equal(report.persistence.insertedRejections, 1);
  assert.equal(report.readiness.history.rejections, 1);
  assert.deepEqual(report.readiness.history.rejectionCodes, { identity_unresolved: 1 });
  assert.ok(report.readiness.issues.includes('ingest_rejections_present'));
});

test('invalid modes are rejected before any source request is made', async () => {
  let fetched = false;
  await assert.rejects(
    runCardmarketPokemonMarketCycle({
      store: store(stateWithMapping()),
      mode: 'automatic',
      fetchImpl: async () => {
        fetched = true;
        throw new Error('must not fetch');
      },
      fetchedAt: FETCHED_AT,
    }),
    /mode must be dry-run or persist/,
  );
  assert.equal(fetched, false);
});
