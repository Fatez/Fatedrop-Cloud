import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeMarketIngestRunId,
  normaliseMarketIngestRejection,
  normaliseMarketIngestRun,
  normaliseMarketObservationCandidate,
} from '../src/trader/value/market-observation.mjs';
import { persistMarketEvidenceBatch } from '../src/trader/value/market-store.mjs';

const NOW = Date.parse('2026-08-28T00:00:00.000Z');
const SOURCE = 'cardmarket';
const SNAPSHOT = 'price-guide-2026-08-28';
const RUN_ID = makeMarketIngestRunId(SOURCE, SNAPSHOT);
const CARD_ID = 'fdcard_0123456789abcdef01234567';
const MAPPING_ID = 'fdcardmap_0123456789abcdef01234567';

function observation(overrides = {}) {
  return normaliseMarketObservationCandidate({
    ingestRunId: RUN_ID,
    cardIdentityId: CARD_ID,
    cardSourceMappingId: MAPPING_ID,
    sourceName: SOURCE,
    sourceSnapshotId: SNAPSHOT,
    sourceRecordId: '12345',
    sourceVariantKey: 'normal',
    currencyCode: 'eur',
    observedAt: NOW,
    sourceEffectiveAt: NOW,
    lowPrice: 81.2,
    trendPrice: 89.4,
    avg1d: 92.1,
    avg7d: 90.3,
    avg30d: 87.8,
    rawPayload: { idProduct: 12345, AVG7: '90.30' },
    ...overrides,
  });
}

function completedRun({ accepted = 1, rejected = 0 } = {}) {
  return normaliseMarketIngestRun({
    sourceName: SOURCE,
    sourceSnapshotId: SNAPSHOT,
    sourceVersion: '2026-08-28',
    startedAt: NOW - 1_000,
    completedAt: NOW,
    status: rejected ? 'partial' : 'completed',
    recordsSeen: accepted + rejected,
    recordsAccepted: accepted,
    recordsRejected: rejected,
  });
}

function memoryStore() {
  const state = {
    traderCatalogue: {
      cards: {
        [CARD_ID]: {
          id: CARD_ID,
          verificationStatus: 'verified',
        },
      },
      cardSourceMappings: {
        [`${SOURCE}|12345|normal`]: {
          id: MAPPING_ID,
          cardIdentityId: CARD_ID,
          sourceName: SOURCE,
          sourceRecordId: '12345',
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

test('market observations preserve native currency and daily market fields', () => {
  const value = observation();

  assert.equal(value.currencyCode, 'EUR');
  assert.equal(value.marketDay, '2026-08-28');
  assert.equal(value.lowPrice, 81.2);
  assert.equal(value.avg7d, 90.3);
  assert.match(value.id, /^fdmarketobs_[a-f0-9]{24}$/);
  assert.match(value.contentFingerprint, /^[a-f0-9]{64}$/);
});

test('content fingerprints are stable across raw JSON key order', () => {
  const left = observation({
    rawPayload: { AVG30: '87.80', idProduct: 12345, nested: { b: 2, a: 1 } },
  });
  const right = observation({
    rawPayload: { nested: { a: 1, b: 2 }, idProduct: 12345, AVG30: '87.80' },
  });

  assert.equal(left.id, right.id);
  assert.equal(left.contentFingerprint, right.contentFingerprint);
});

test('logical observation id stays stable while changed evidence changes fingerprint', () => {
  const first = observation({ avg7d: 90.3 });
  const changed = observation({ avg7d: 91.1 });

  assert.equal(first.id, changed.id);
  assert.notEqual(first.contentFingerprint, changed.contentFingerprint);
});

test('market observations reject negative values and metric-free evidence', () => {
  assert.throws(() => observation({ lowPrice: -1 }), /lowPrice/);

  assert.throws(() => normaliseMarketObservationCandidate({
    cardIdentityId: CARD_ID,
    cardSourceMappingId: MAPPING_ID,
    sourceName: SOURCE,
    sourceSnapshotId: SNAPSHOT,
    sourceRecordId: '12345',
    sourceVariantKey: 'normal',
    currencyCode: 'EUR',
    observedAt: NOW,
  }), /at least one market metric/);
});

test('terminal ingest run counts must be internally consistent', () => {
  assert.throws(() => normaliseMarketIngestRun({
    sourceName: SOURCE,
    sourceSnapshotId: SNAPSHOT,
    startedAt: NOW - 1_000,
    completedAt: NOW,
    status: 'completed',
    recordsSeen: 1,
    recordsAccepted: 1,
    recordsRejected: 1,
  }), /cannot exceed recordsSeen/);

  assert.throws(() => normaliseMarketIngestRun({
    sourceName: SOURCE,
    sourceSnapshotId: SNAPSHOT,
    startedAt: NOW,
    status: 'completed',
  }), /completedAt/);
});

test('unmapped evidence can be retained as a rejection without inventing a card identity', () => {
  const rejection = normaliseMarketIngestRejection({
    ingestRunId: RUN_ID,
    sourceName: SOURCE,
    sourceSnapshotId: SNAPSHOT,
    sourceRecordId: '99999',
    sourceVariantKey: 'normal',
    rejectionCode: 'identity_unresolved',
    rejectionDetail: 'No verified FateDrop card mapping',
    rawPayload: { idProduct: 99999 },
    createdAt: NOW,
  });

  assert.equal(rejection.ingestRunId, RUN_ID);
  assert.equal(rejection.rejectionCode, 'identity_unresolved');
  assert.match(rejection.id, /^fdmarketreject_[a-f0-9]{24}$/);
});

test('file persistence is idempotent for identical immutable observations', async () => {
  const store = memoryStore();
  const run = completedRun();
  const value = observation();

  const first = await persistMarketEvidenceBatch(store, {
    run,
    observations: [value],
    rejections: [],
  });
  const second = await persistMarketEvidenceBatch(store, {
    run,
    observations: [value],
    rejections: [],
  });

  assert.deepEqual(first, {
    insertedObservations: 1,
    duplicateObservations: 0,
    insertedRejections: 0,
  });
  assert.deepEqual(second, {
    insertedObservations: 0,
    duplicateObservations: 1,
    insertedRejections: 0,
  });
});

test('persistence rejects mutation of an already-recorded logical observation', async () => {
  const store = memoryStore();
  const run = completedRun();

  await persistMarketEvidenceBatch(store, {
    run,
    observations: [observation({ avg7d: 90.3 })],
    rejections: [],
  });

  await assert.rejects(
    persistMarketEvidenceBatch(store, {
      run,
      observations: [observation({ avg7d: 91.1 })],
      rejections: [],
    }),
    /Immutable market observation conflict/,
  );
});

test('persistence refuses market evidence whose source mapping is not canonical', async () => {
  const store = memoryStore();
  const run = completedRun();

  await assert.rejects(
    persistMarketEvidenceBatch(store, {
      run,
      observations: [observation({ cardSourceMappingId: 'fdcardmap_missing' })],
      rejections: [],
    }),
    /requires a canonical card source mapping/,
  );
});

test('persistence refuses market evidence mapped to an unverified card identity', async () => {
  const store = memoryStore();
  const run = completedRun();
  store.state.traderCatalogue.cards[CARD_ID].verificationStatus = 'staged';

  await assert.rejects(
    persistMarketEvidenceBatch(store, {
      run,
      observations: [observation()],
      rejections: [],
    }),
    /requires a verified canonical card identity/,
  );
});

test('rejection-only batches preserve unknown evidence', async () => {
  const store = memoryStore();
  const run = completedRun({ accepted: 0, rejected: 1 });
  const rejection = normaliseMarketIngestRejection({
    ingestRunId: run.id,
    sourceName: SOURCE,
    sourceSnapshotId: SNAPSHOT,
    sourceRecordId: '99999',
    sourceVariantKey: 'normal',
    rejectionCode: 'identity_unresolved',
    rawPayload: { idProduct: 99999 },
    createdAt: NOW,
  });

  const result = await persistMarketEvidenceBatch(store, {
    run,
    observations: [],
    rejections: [rejection],
  });

  assert.equal(result.insertedRejections, 1);
  assert.equal(store.state.fateValueLab.rejections[rejection.id].rejectionCode, 'identity_unresolved');
});
