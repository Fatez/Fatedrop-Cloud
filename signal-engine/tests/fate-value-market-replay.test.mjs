import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseMarketObservationCandidate } from '../src/trader/value/market-observation.mjs';

const SOURCE_EFFECTIVE_AT = Date.parse('2026-08-28T00:00:00.000Z');

function candidate(overrides = {}) {
  return normaliseMarketObservationCandidate({
    cardIdentityId: 'fdcard_0123456789abcdef01234567',
    cardSourceMappingId: 'fdcardmap_0123456789abcdef01234567',
    sourceName: 'cardmarket',
    sourceSnapshotId: 'price-guide-2026-08-28',
    sourceRecordId: '12345',
    sourceVariantKey: 'normal',
    currencyCode: 'EUR',
    observedAt: SOURCE_EFFECTIVE_AT,
    sourceEffectiveAt: SOURCE_EFFECTIVE_AT,
    avg7d: 90.3,
    rawPayload: { idProduct: 12345, AVG7: '90.30' },
    ...overrides,
  });
}

test('replaying an unchanged source snapshot later keeps the same immutable fingerprint', () => {
  const first = candidate({ observedAt: SOURCE_EFFECTIVE_AT });
  const replay = candidate({ observedAt: SOURCE_EFFECTIVE_AT + 60_000 });

  assert.equal(first.id, replay.id);
  assert.equal(first.contentFingerprint, replay.contentFingerprint);
  assert.notEqual(first.observedAt, replay.observedAt);
});

test('native currency is part of the logical observation identity', () => {
  const euro = candidate({ currencyCode: 'EUR' });
  const sterling = candidate({ currencyCode: 'GBP' });

  assert.notEqual(euro.id, sterling.id);
  assert.notEqual(euro.contentFingerprint, sterling.contentFingerprint);
});
