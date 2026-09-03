import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptCardmarketPriceGuideSnapshot,
  buildCardmarketPriceGuideBatch,
} from '../src/trader/value/cardmarket-adapter.mjs';

const payload = {
  version: 1,
  createdAt: '2026-09-03T10:00:00+0000',
  priceGuides: [{
    idProduct: 123,
    idCategory: 6,
    avg: 1,
    low: 0.5,
    trend: 1.2,
    avg1: 1.1,
    avg7: 1.0,
    avg30: 0.9,
  }],
};

const mapping = {
  id: 'mapping-1',
  cardIdentityId: 'card-1',
  sourceName: 'cardmarket',
  sourceRecordId: '123',
  sourceVariantKey: 'standard',
};

test('Cardmarket snapshots retain Pokémon as the backwards-compatible default', () => {
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload);
  assert.equal(snapshot.tcgCode, 'pokemon');
  assert.match(snapshot.sourceSnapshotId, /^pokemon-price-guide-v1-/);
});

test('Cardmarket snapshots are namespaced by canonical TCG', () => {
  const snapshot = adaptCardmarketPriceGuideSnapshot(payload, { tcgCode: 'one-piece' });
  assert.equal(snapshot.tcgCode, 'one-piece');
  assert.match(snapshot.sourceSnapshotId, /^one-piece-price-guide-v1-/);
});

test('Cardmarket batch records approved acquisition policy and passes TCG to mapping resolver', async () => {
  const resolverCalls = [];
  const batch = await buildCardmarketPriceGuideBatch(payload, {
    tcgCode: 'one-piece',
    lanes: ['standard'],
    observedAt: Date.parse('2026-09-03T10:10:00Z'),
    resolveMapping: async (input) => {
      resolverCalls.push(input);
      return mapping;
    },
  });

  assert.equal(batch.snapshot.tcgCode, 'one-piece');
  assert.equal(batch.run.metadataJson.tcgCode, 'one-piece');
  assert.equal(batch.run.metadataJson.providerPolicyKey, 'cardmarket-public-download');
  assert.equal(batch.run.metadataJson.acquisitionMode, 'public-download');
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].tcgCode, 'one-piece');
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].metricsJson.tcgCode, 'one-piece');
});

test('unknown TCG codes fail closed before creating a Cardmarket snapshot', () => {
  assert.throws(
    () => adaptCardmarketPriceGuideSnapshot(payload, { tcgCode: 'made-up-game' }),
    /Unknown TCG|Unsupported TCG|known TCG/i,
  );
});
