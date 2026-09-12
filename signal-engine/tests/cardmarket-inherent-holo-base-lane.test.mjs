import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCardmarketPriceGuideBatch,
} from '../src/trader/value/cardmarket-adapter.mjs';
import {
  CARDMARKET_INHERENT_HOLO_BASE_LANE_AUDIT,
  CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS,
  CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_ID_SET,
} from '../src/trader/value/cardmarket-inherent-holo-base-lane-policy.mjs';
import {
  collectCurrentGuideInherentHoloBaseLaneEligibleProductIds,
  resolveCardmarketBatchMapping,
} from '../src/trader/value/cardmarket-daily-ingest.mjs';

const AUDITED_PRODUCT_ID = CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS[0];

function mapping(sourceRecordId, sourceVariantKey, suffix = sourceVariantKey) {
  return Object.freeze({
    id: `mapping-${suffix}`,
    cardIdentityId: `identity-${suffix}`,
    sourceName: 'cardmarket',
    sourceRecordId,
    sourceVariantKey,
  });
}

function mappingMap(entries) {
  return new Map(entries.map(([productId, variant, value]) => [
    JSON.stringify([String(productId), variant]),
    value,
  ]));
}

function priceGuidePayload(rows) {
  return {
    version: 6,
    createdAt: '2026-09-12T00:49:54Z',
    priceGuides: rows,
  };
}

test('audited inherent-holo allowlist remains exactly the frozen 2,051 unique products', () => {
  assert.equal(CARDMARKET_INHERENT_HOLO_BASE_LANE_AUDIT.candidateCount, 2051);
  assert.equal(CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS.length, 2051);
  assert.equal(CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_ID_SET.size, 2051);
});

test('current guide eligibility requires meaningful base lane and empty holo lane', () => {
  const eligible = collectCurrentGuideInherentHoloBaseLaneEligibleProductIds(priceGuidePayload([
    { idProduct: Number(AUDITED_PRODUCT_ID), trend: 12.5, 'trend-holo': 0 },
    {
      idProduct: Number(CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS[1]),
      trend: 8.2,
      'trend-holo': 8.3,
    },
    { idProduct: 123456789, trend: 4.2, 'trend-holo': 0 },
  ]));

  assert.deepEqual([...eligible], [AUDITED_PRODUCT_ID]);
});

test('exact normal ownership remains exact standard resolution', () => {
  const normal = mapping(AUDITED_PRODUCT_ID, 'normal', 'normal');
  const holo = mapping(AUDITED_PRODUCT_ID, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([
      [AUDITED_PRODUCT_ID, 'normal', normal],
      [AUDITED_PRODUCT_ID, 'holo', holo],
    ]),
    sourceName: 'cardmarket',
    sourceRecordId: AUDITED_PRODUCT_ID,
    priceGuideLane: 'standard',
  });

  assert.equal(resolved, normal);
  assert.equal(resolved.sourceVariantKey, 'normal');
});

test('audited provider base values remain canonical holo observations', async () => {
  const holo = mapping(AUDITED_PRODUCT_ID, 'holo', 'holo');
  const resolverRequests = [];
  const batch = await buildCardmarketPriceGuideBatch(priceGuidePayload([
    {
      idProduct: Number(AUDITED_PRODUCT_ID),
      idCategory: 1,
      avg: 12,
      low: 9.5,
      trend: 12.5,
      avg1: 12.1,
      avg7: 11.9,
      avg30: 11.4,
      'avg-holo': 0,
      'low-holo': 0,
      'trend-holo': 0,
      'avg1-holo': 0,
      'avg7-holo': 0,
      'avg30-holo': 0,
    },
  ]), {
    observedAt: Date.parse('2026-09-12T01:00:00Z'),
    inherentHoloBaseLaneProductIds: new Set([AUDITED_PRODUCT_ID]),
    resolveMapping: async (request) => {
      resolverRequests.push(request);
      return request.priceGuideLane === 'holo' ? holo : null;
    },
  });

  assert.equal(batch.observations.length, 1);
  assert.equal(batch.rejections.length, 0);
  assert.equal(resolverRequests.length, 1);
  assert.equal(resolverRequests[0].priceGuideLane, 'holo');
  assert.equal(resolverRequests[0].providerPriceGuideLane, 'standard');

  const [observation] = batch.observations;
  assert.equal(observation.cardIdentityId, 'identity-holo');
  assert.equal(observation.sourceVariantKey, 'holo');
  assert.equal(observation.marketSegmentKey, 'holo');
  assert.equal(observation.trendPrice, 12.5);
  assert.equal(observation.metricsJson.priceGuideLane, 'holo');
  assert.equal(observation.metricsJson.providerPriceGuideLane, 'standard');
});

test('non-allowlisted holo can never satisfy the provider base lane', () => {
  const productId = '123456789';
  const holo = mapping(productId, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([[productId, 'holo', holo]]),
    sourceName: 'cardmarket',
    sourceRecordId: productId,
    priceGuideLane: 'standard',
  });

  assert.equal(resolved, null);
});

test('ambiguous normal ownership remains fail-closed', () => {
  const holo = mapping(AUDITED_PRODUCT_ID, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([
      [AUDITED_PRODUCT_ID, 'normal', null],
      [AUDITED_PRODUCT_ID, 'holo', holo],
    ]),
    sourceName: 'cardmarket',
    sourceRecordId: AUDITED_PRODUCT_ID,
    priceGuideLane: 'standard',
  });

  assert.equal(resolved, null);
});

test('holo provider lane still resolves only the exact holo mapping', () => {
  const holo = mapping(AUDITED_PRODUCT_ID, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([[AUDITED_PRODUCT_ID, 'holo', holo]]),
    sourceName: 'cardmarket',
    sourceRecordId: AUDITED_PRODUCT_ID,
    priceGuideLane: 'holo',
  });

  assert.equal(resolved, holo);
  assert.equal(resolved.sourceVariantKey, 'holo');
});

test('reverse remains outside Cardmarket daily price-lane resolution', () => {
  assert.throws(() => resolveCardmarketBatchMapping({
    mappings: new Map(),
    sourceName: 'cardmarket',
    sourceRecordId: AUDITED_PRODUCT_ID,
    priceGuideLane: 'reverse',
  }), /unsupported Cardmarket price lane/);
});
