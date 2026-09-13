import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const path = new URL('../evidence/active-unpriced-cardmarket-recovery-2026-09-13.json', import.meta.url);

test('active-unpriced Cardmarket recovery manifest stays exact and fail-closed', async () => {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(manifest.expectedActiveUnpriced, 87);
  assert.equal(manifest.expectedCandidates, 23);
  assert.equal(manifest.candidates.length, 23);
  assert.equal(new Set(manifest.candidates.map(row => row.cardIdentityId)).size, 23);
  assert.equal(new Set(manifest.candidates.map(row => `${row.sourceRecordId}|${row.sourceVariantKey}`)).size, 23);
  assert.equal(manifest.source.tcgdexRevision, '5b6a2859f454972477a9953ffe5cb554d24c45e9');
  assert.match(manifest.source.cardmarketCatalogueSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.source.cardmarketPriceGuideSha256, /^[a-f0-9]{64}$/);
  for (const row of manifest.candidates) {
    assert.equal(row.variantCode, 'standard');
    assert.equal(row.sourceVariantKey, 'normal');
    assert.ok(row.cardIdentityId.startsWith('fdcard_'));
    assert.ok(row.tcgdexCardId);
    assert.match(String(row.sourceRecordId), /^\d+$/);
  }
});
