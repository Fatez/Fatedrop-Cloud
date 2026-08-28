import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseMarketIngestRun,
  normaliseMarketObservationCandidate,
} from '../src/trader/value/market-observation.mjs';
import { persistMarketEvidenceBatch } from '../src/trader/value/market-store.mjs';

const NOW = Date.parse('2026-08-28T00:00:00.000Z');
const CARD_ID = 'fdcard_atomicity';
const MAPPING_ID = 'fdcardmap_atomicity';

function storeWithCard(verificationStatus) {
  const state = {
    traderCatalogue: {
      cards: {
        [CARD_ID]: { id: CARD_ID, verificationStatus },
      },
      cardSourceMappings: {
        'cardmarket|668227|normal': {
          id: MAPPING_ID,
          cardIdentityId: CARD_ID,
          sourceName: 'cardmarket',
          sourceRecordId: '668227',
          sourceVariantKey: 'normal',
        },
      },
    },
  };
  return {
    state,
    mutate(fn) {
      return fn(state);
    },
  };
}

function batch() {
  const run = normaliseMarketIngestRun({
    sourceName: 'cardmarket',
    sourceSnapshotId: 'atomicity-snapshot',
    startedAt: NOW - 1_000,
    completedAt: NOW,
    status: 'completed',
    recordsSeen: 1,
    recordsAccepted: 1,
    recordsRejected: 0,
  });
  const observation = normaliseMarketObservationCandidate({
    ingestRunId: run.id,
    cardIdentityId: CARD_ID,
    cardSourceMappingId: MAPPING_ID,
    sourceName: 'cardmarket',
    sourceSnapshotId: run.sourceSnapshotId,
    sourceRecordId: '668227',
    sourceVariantKey: 'normal',
    currencyCode: 'EUR',
    observedAt: NOW,
    sourceEffectiveAt: NOW,
    avg7d: 8.8,
  });
  return { run, observations: [observation], rejections: [] };
}

test('rejected staged mapping leaves no Fate Value file state behind', async () => {
  const store = storeWithCard('staged');

  await assert.rejects(
    persistMarketEvidenceBatch(store, batch()),
    /requires a verified canonical card identity/,
  );

  assert.equal(store.state.fateValueLab, undefined);
});

test('verified mapping creates Fate Value file state only after validation succeeds', async () => {
  const store = storeWithCard('verified');
  const value = batch();

  const result = await persistMarketEvidenceBatch(store, value);

  assert.equal(result.insertedObservations, 1);
  assert.equal(store.state.fateValueLab.ingestRuns[value.run.id].id, value.run.id);
  assert.equal(Object.keys(store.state.fateValueLab.observations).length, 1);
});
