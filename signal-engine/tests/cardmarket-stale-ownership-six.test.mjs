import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARDMARKET_STALE_OWNERSHIP_SIX,
  CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST,
  stableCardmarketMappingId,
  staleOwnershipSixDigest,
} from '../src/trader/value/cardmarket-stale-ownership-six.mjs';

test('stale ownership six manifest is exact and collision-free', () => {
  assert.equal(CARDMARKET_STALE_OWNERSHIP_SIX.length, 6);
  assert.equal(staleOwnershipSixDigest(), CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST);

  const identityIds = new Set();
  const sourceKeys = new Set();
  const targetMappingIds = new Set();
  const displacedMappingIds = new Set();
  for (const pair of CARDMARKET_STALE_OWNERSHIP_SIX) {
    assert.ok(['normal', 'holo'].includes(pair.sourceVariantKey));
    assert.notEqual(pair.target.cardIdentityId, pair.displaced.cardIdentityId);
    assert.notEqual(String(pair.target.sourceRecordId), String(pair.displaced.sourceRecordId));
    assert.equal(pair.target.expansionId, pair.displaced.expansionId);
    assert.equal(pair.target.variantCode === 'holo' ? 'holo' : 'normal', pair.sourceVariantKey);
    assert.equal(pair.displaced.variantCode === 'holo' ? 'holo' : 'normal', pair.sourceVariantKey);

    for (const id of [pair.target.cardIdentityId, pair.displaced.cardIdentityId]) {
      assert.equal(identityIds.has(id), false, `duplicate identity ${id}`);
      identityIds.add(id);
    }
    for (const sourceRecordId of [pair.target.sourceRecordId, pair.displaced.sourceRecordId]) {
      const key = `${sourceRecordId}|${pair.sourceVariantKey}`;
      assert.equal(sourceKeys.has(key), false, `duplicate source key ${key}`);
      sourceKeys.add(key);
    }

    const targetMappingId = stableCardmarketMappingId(pair.target.cardIdentityId, pair.target.sourceRecordId, pair.sourceVariantKey);
    const displacedMappingId = stableCardmarketMappingId(pair.displaced.cardIdentityId, pair.displaced.sourceRecordId, pair.sourceVariantKey);
    assert.equal(targetMappingIds.has(targetMappingId), false);
    assert.equal(displacedMappingIds.has(displacedMappingId), false);
    targetMappingIds.add(targetMappingId);
    displacedMappingIds.add(displacedMappingId);
  }

  assert.equal(identityIds.size, 12);
  assert.equal(sourceKeys.size, 12);
});

test('manifest pins the six blocked target keys and six replacement owner keys', () => {
  const pairs = CARDMARKET_STALE_OWNERSHIP_SIX.map((row) => `${row.target.sourceRecordId}/${row.sourceVariantKey}->${row.displaced.sourceRecordId}/${row.sourceVariantKey}`);
  assert.deepEqual(pairs, [
    '276425/holo->276510/holo',
    '278998/holo->279081/holo',
    '278207/normal->278208/normal',
    '278364/normal->278365/normal',
    '279180/holo->279243/holo',
    '281314/normal->291974/normal',
  ]);
});
