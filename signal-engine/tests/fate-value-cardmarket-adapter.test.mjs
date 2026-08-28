import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptCardmarketPriceGuideRow,
  adaptCardmarketPriceGuideSnapshot,
  buildCardmarketPriceGuideBatch,
  hasMeaningfulCardmarketLane,
} from '../src/trader/value/cardmarket-adapter.mjs';

const OBSERVED_AT = Date.parse('2026-08-28T00:30:00.000Z');

function payload(rows) {
  return {
    version: 1,
    createdAt: '2026-06-29T02:55:18+0200',
    priceGuides: rows,
  };
}

function standardRow(overrides = {}) {
  return {
    idProduct: 668227,
    idCategory: 51,
    avg: 8.93,
    low: 5,
    trend: 11.25,
    avg1: 8.45,
    avg7: 8.8,
    avg30: 9.39,
    'avg-holo': null,
    'low-holo': null,
    'trend-holo': 0,
    'avg1-holo': null,
    'avg7-holo': null,
    'avg30-holo': null,
    ...overrides,
  };
}

function holoRow(overrides = {}) {
  return standardRow({
    idProduct: 884602,
    avg: null,
    low: 0.02,
    trend: 0,
    avg1: null,
    avg7: null,
    avg30: null,
    'avg-holo': 0.1,
    'low-holo': 0.02,
    'trend-holo': 0.13,
    'avg1-holo': 0.15,
    'avg7-holo': 0.12,
    'avg30-holo': 0.1,
    ...overrides,
  });
}

function mapping(productId, sourceVariantKey = 'normal', cardIdentityId = 'fdcard_0123456789abcdef01234567') {
  return {
    id: `fdcardmap_${productId}_${sourceVariantKey}`,
    cardIdentityId,
    sourceName: 'cardmarket',
    sourceRecordId: String(productId),
    sourceVariantKey,
  };
}

test('Cardmarket snapshot identity comes from provider timestamp, not ingest time', () => {
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload([standardRow()]));

  assert.equal(snapshot.sourceName, 'cardmarket');
  assert.equal(snapshot.sourceVersion, '1');
  assert.equal(snapshot.currencyCode, 'EUR');
  assert.equal(snapshot.sourceEffectiveAt, Date.parse('2026-06-29T00:55:18.000Z'));
  assert.equal(snapshot.sourceSnapshotId, 'pokemon-price-guide-v1-2026-06-29T00:55:18.000Z');
});

test('standard Cardmarket lane maps source fields without calculating a Fate value', () => {
  const row = standardRow();
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload([row]));
  const observation = adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: mapping(668227),
    lane: 'standard',
    observedAt: OBSERVED_AT,
  });

  assert.equal(observation.currencyCode, 'EUR');
  assert.equal(observation.marketSegmentKey, 'standard');
  assert.equal(observation.avgLifetime, 8.93);
  assert.equal(observation.lowPrice, 5);
  assert.equal(observation.trendPrice, 11.25);
  assert.equal(observation.avg1d, 8.45);
  assert.equal(observation.avg7d, 8.8);
  assert.equal(observation.avg30d, 9.39);
  assert.equal(observation.marketPrice, null);
  assert.deepEqual(observation.rawPayload, row);
});

test('zero-only holo placeholders do not create false market evidence', () => {
  const row = standardRow();
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload([row]));

  assert.equal(hasMeaningfulCardmarketLane(row, 'holo'), false);
  assert.equal(adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: mapping(668227, 'holo'),
    lane: 'holo',
    observedAt: OBSERVED_AT,
  }), null);
});

test('holo lane is only emitted when explicitly requested with its own mapping', () => {
  const row = holoRow();
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload([row]));
  const observation = adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: mapping(884602, 'holo'),
    lane: 'holo',
    observedAt: OBSERVED_AT,
  });

  assert.equal(observation.sourceVariantKey, 'holo');
  assert.equal(observation.marketSegmentKey, 'holo');
  assert.equal(observation.avgLifetime, 0.1);
  assert.equal(observation.lowPrice, 0.02);
  assert.equal(observation.trendPrice, 0.13);
  assert.equal(observation.avg7d, 0.12);
});

test('adapter refuses mismatched provider mappings instead of guessing', () => {
  const row = standardRow();
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload([row]));

  assert.throws(() => adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: { ...mapping(668227), sourceName: 'tcgdex' },
    lane: 'standard',
    observedAt: OBSERVED_AT,
  }), /requires a Cardmarket source mapping/);

  assert.throws(() => adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: mapping(999999),
    lane: 'standard',
    observedAt: OBSERVED_AT,
  }), /product mismatch/);
});

test('batch quarantines unresolved lanes and does not fabricate a card identity', async () => {
  const result = await buildCardmarketPriceGuideBatch(payload([standardRow()]), {
    observedAt: OBSERVED_AT,
    resolveMapping: async () => null,
  });

  assert.equal(result.observations.length, 0);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].rejectionCode, 'identity_unresolved');
  assert.equal(result.rejections[0].sourceRecordId, '668227');
  assert.equal(result.run.status, 'partial');
  assert.equal(result.run.recordsSeen, 1);
  assert.equal(result.run.recordsRejected, 1);
});

test('batch only asks resolver for meaningful lanes', async () => {
  const requested = [];
  const result = await buildCardmarketPriceGuideBatch(payload([standardRow()]), {
    observedAt: OBSERVED_AT,
    resolveMapping: async (request) => {
      requested.push(request);
      return mapping(request.sourceRecordId, 'normal');
    },
  });

  assert.deepEqual(requested, [{
    sourceName: 'cardmarket',
    sourceRecordId: '668227',
    priceGuideLane: 'standard',
  }]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.run.status, 'completed');
});

test('same provider snapshot stays stable across different ingest times', () => {
  const row = standardRow();
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload([row]));
  const first = adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: mapping(668227),
    lane: 'standard',
    observedAt: OBSERVED_AT,
  });
  const replay = adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: mapping(668227),
    lane: 'standard',
    observedAt: OBSERVED_AT + 60_000,
  });

  assert.equal(first.id, replay.id);
  assert.equal(first.contentFingerprint, replay.contentFingerprint);
  assert.notEqual(first.observedAt, replay.observedAt);
});

test('malformed Cardmarket snapshots and negative prices are rejected', () => {
  assert.throws(() => adaptCardmarketPriceGuideSnapshot({
    version: 1,
    createdAt: 'not-a-date',
    priceGuides: [],
  }), /createdAt is invalid/);

  const row = standardRow({ low: -1 });
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload([row]));
  assert.throws(() => hasMeaningfulCardmarketLane(row, 'standard'), /row.low/);
  assert.throws(() => adaptCardmarketPriceGuideRow(row, {
    snapshot,
    mapping: mapping(668227),
    lane: 'standard',
    observedAt: OBSERVED_AT,
  }), /row.low/);
});
