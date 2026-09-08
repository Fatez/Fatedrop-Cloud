import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareCardmarketEvidenceBundle,
  sha256Hex,
  validateCardmarketPriceLaneMapping,
} from '../src/trader/value/cardmarket-preparation-bundle.mjs';

const payload = Object.freeze({
  version: 1,
  createdAt: '2026-09-08T12:00:00+0000',
  priceGuides: Object.freeze([
    Object.freeze({
      idProduct: 1001,
      idCategory: 1,
      avg: 10,
      low: 8,
      trend: 9,
      avg1: 9.5,
      avg7: 9.25,
      avg30: 9,
      'avg-holo': 20,
      'low-holo': 18,
      'trend-holo': 19,
      'avg1-holo': 19.5,
      'avg7-holo': 19.25,
      'avg30-holo': 19,
    }),
    Object.freeze({
      idProduct: 1002,
      idCategory: 1,
      avg: null,
      low: null,
      trend: null,
      avg1: null,
      avg7: null,
      avg30: null,
    }),
  ]),
});

function mapping(overrides = {}) {
  return {
    id: 'map-1',
    cardIdentityId: 'identity-1',
    sourceName: 'cardmarket',
    sourceRecordId: '1001',
    sourceVariantKey: 'standard',
    ...overrides,
  };
}

test('reverse holo mapping is quarantined instead of borrowing standard or holo evidence', () => {
  assert.deepEqual(
    validateCardmarketPriceLaneMapping(mapping({ sourceVariantKey: 'reverse-holo' }), 'holo'),
    { ok: false, reason: 'reverse_holo_requires_finish_specific_evidence' },
  );
  assert.deepEqual(
    validateCardmarketPriceLaneMapping(mapping({ sourceVariantKey: 'reverse-holo' }), 'standard'),
    { ok: false, reason: 'reverse_holo_requires_finish_specific_evidence' },
  );
});

test('finish lane mismatches and unconfirmed finishes fail closed', () => {
  assert.deepEqual(
    validateCardmarketPriceLaneMapping(mapping({ sourceVariantKey: 'holo' }), 'standard'),
    { ok: false, reason: 'finish_price_lane_mismatch' },
  );
  assert.deepEqual(
    validateCardmarketPriceLaneMapping(mapping({ sourceVariantKey: 'variant-x' }), 'standard'),
    { ok: false, reason: 'finish_unconfirmed' },
  );
});

test('preparation bundle is review-only, deterministic and keeps missing prices unknown', async () => {
  const sourceBytes = Buffer.from(JSON.stringify(payload));
  const resolveMapping = ({ sourceRecordId, priceGuideLane }) => {
    if (sourceRecordId !== '1001') return null;
    if (priceGuideLane === 'standard') return mapping();
    if (priceGuideLane === 'holo') return mapping({
      id: 'map-2',
      cardIdentityId: 'identity-2',
      sourceVariantKey: 'holo',
    });
    return null;
  };

  const first = await prepareCardmarketEvidenceBundle(payload, {
    sourceBytes,
    observedAt: 1_725_796_800_000,
    resolveMapping,
  });
  const second = await prepareCardmarketEvidenceBundle(payload, {
    sourceBytes,
    observedAt: 1_725_796_800_000,
    resolveMapping,
  });

  assert.equal(first.report.mode, 'review_only_no_database_writes');
  assert.equal(first.report.validation.writesPerformed, false);
  assert.equal(first.report.validation.productionTouched, false);
  assert.equal(first.report.validation.missingPricePolicy, 'unknown_not_zero');
  assert.equal(first.report.counts.discoveredSourceRows, 2);
  assert.equal(first.report.counts.verifiedCanonicalIdentitiesReferenced, 2);
  assert.equal(first.report.counts.exactMappingsReferenced, 2);
  assert.equal(first.report.counts.pricedCanonicalIdentitiesPrepared, 2);
  assert.equal(first.report.counts.productionVerifiedIdentities, null);
  assert.equal(first.report.source.sha256, sha256Hex(sourceBytes));
  assert.equal(first.deterministicReportSha256, second.deterministicReportSha256);
  assert.deepEqual(first.report, second.report);
});

test('reverse holo exact identity remains visible in quarantine and is not priced', async () => {
  const result = await prepareCardmarketEvidenceBundle(payload, {
    observedAt: 1_725_796_800_000,
    resolveMapping: ({ sourceRecordId, priceGuideLane }) => {
      if (sourceRecordId !== '1001' || priceGuideLane !== 'holo') return null;
      return mapping({
        id: 'map-reverse',
        cardIdentityId: 'identity-reverse',
        sourceVariantKey: 'reverse-holo',
      });
    },
  });

  assert.equal(result.report.counts.quarantinedFinishMappings, 1);
  assert.equal(result.report.counts.pricedCanonicalIdentitiesPrepared, 0);
  assert.equal(result.report.quarantinedMappings[0].cardIdentityId, 'identity-reverse');
  assert.equal(result.report.quarantinedMappings[0].reason, 'reverse_holo_requires_finish_specific_evidence');
  assert.ok(result.report.rejections.some((row) => row.rejectionCode === 'identity_unresolved'));
});
