import test from 'node:test';
import assert from 'node:assert/strict';

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

test('audited inherent-holo allowlist remains exactly the frozen 2,051 unique products', () => {
  assert.equal(CARDMARKET_INHERENT_HOLO_BASE_LANE_AUDIT.candidateCount, 2051);
  assert.equal(CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS.length, 2051);
  assert.equal(CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_ID_SET.size, 2051);
});

test('current guide eligibility requires meaningful base lane and empty holo lane', () => {
  const eligible = collectCurrentGuideInherentHoloBaseLaneEligibleProductIds({
    priceGuides: [
      { idProduct: Number(AUDITED_PRODUCT_ID), trend: 12.5, 'trend-holo': 0 },
      { idProduct: Number(CARDMARKET_INHERENT_HOLO_BASE_LANE_PRODUCT_IDS[1]), trend: 8.2, 'trend-holo': 8.3 },
      { idProduct: 123456789, trend: 4.2, 'trend-holo': 0 },
    ],
  });

  assert.deepEqual([...eligible], [AUDITED_PRODUCT_ID]);
});

test('exact normal ownership wins over inherent-holo base-lane fallback', () => {
  const normal = mapping(AUDITED_PRODUCT_ID, 'normal', 'normal');
  const holo = mapping(AUDITED_PRODUCT_ID, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([
      [AUDITED_PRODUCT_ID, 'normal', normal],
      [AUDITED_PRODUCT_ID, 'holo', holo],
    ]),
    validInherentHoloProductIds: new Set([AUDITED_PRODUCT_ID]),
    eligibleInherentHoloProductIds: new Set([AUDITED_PRODUCT_ID]),
    sourceName: 'cardmarket',
    sourceRecordId: AUDITED_PRODUCT_ID,
    priceGuideLane: 'standard',
  });

  assert.equal(resolved, normal);
  assert.equal(resolved.sourceVariantKey, 'normal');
});

test('audited inherent-holo product may use provider base lane while remaining canonical holo', () => {
  const holo = mapping(AUDITED_PRODUCT_ID, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([[AUDITED_PRODUCT_ID, 'holo', holo]]),
    validInherentHoloProductIds: new Set([AUDITED_PRODUCT_ID]),
    eligibleInherentHoloProductIds: new Set([AUDITED_PRODUCT_ID]),
    sourceName: 'cardmarket',
    sourceRecordId: AUDITED_PRODUCT_ID,
    priceGuideLane: 'standard',
  });

  assert.equal(resolved, holo);
  assert.equal(resolved.sourceVariantKey, 'holo');
  assert.equal(resolved.cardIdentityId, 'identity-holo');
});

test('non-allowlisted holo can never satisfy the provider base lane', () => {
  const productId = '123456789';
  const holo = mapping(productId, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([[productId, 'holo', holo]]),
    validInherentHoloProductIds: new Set([productId]),
    eligibleInherentHoloProductIds: new Set([productId]),
    sourceName: 'cardmarket',
    sourceRecordId: productId,
    priceGuideLane: 'standard',
  });

  assert.equal(resolved, null);
});

test('ambiguous normal ownership blocks fallback instead of choosing holo', () => {
  const holo = mapping(AUDITED_PRODUCT_ID, 'holo', 'holo');
  const resolved = resolveCardmarketBatchMapping({
    mappings: mappingMap([
      [AUDITED_PRODUCT_ID, 'normal', null],
      [AUDITED_PRODUCT_ID, 'holo', holo],
    ]),
    validInherentHoloProductIds: new Set([AUDITED_PRODUCT_ID]),
    eligibleInherentHoloProductIds: new Set([AUDITED_PRODUCT_ID]),
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
    validInherentHoloProductIds: new Set(),
    eligibleInherentHoloProductIds: new Set(),
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
