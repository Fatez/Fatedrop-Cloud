import assert from 'node:assert/strict';
import test from 'node:test';

import { ingestRetailerProducts, scanRetailer } from '../src/core/engine.mjs';

const inactiveRetailer = Object.freeze({
  id: 'lorcana-fixture',
  name: 'Lorcana Fixture',
  tcg: 'lorcana',
  adapterType: 'html',
});

const onePieceShadowRetailer = Object.freeze({
  id: 'one-piece-fixture',
  name: 'One Piece Fixture',
  tcg: 'one-piece',
  adapterType: 'html',
});

test('inactive TCG retailer monitoring stops before any external request', async () => {
  let called = false;
  const result = await scanRetailer({
    retailer: inactiveRetailer,
    store: {},
    scanSource: async () => { called = true; return { products: [] }; },
  });
  assert.equal(called, false);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'tcg_retailer_monitoring_disabled');
  assert.equal(result.signalsCreated, 0);
});

test('inactive TCG catalogue ingestion stops before persistence', async () => {
  await assert.rejects(
    () => ingestRetailerProducts({
      retailer: inactiveRetailer,
      store: { saveScan: async () => { throw new Error('must not persist'); } },
      products: [{ title: 'Fixture', retailerSku: 'fixture', url: 'https://example.invalid/fixture' }],
    }),
    (error) => error?.code === 'tcg_catalogue_ingestion_disabled',
  );
});

test('One Piece catalogue shadow still blocks live retailer scanning before any external request', async () => {
  let called = false;
  const result = await scanRetailer({
    retailer: onePieceShadowRetailer,
    store: {},
    scanSource: async () => { called = true; return { products: [] }; },
  });
  assert.equal(called, false);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'tcg_retailer_monitoring_disabled');
  assert.equal(result.signalsCreated, 0);
});

test('unknown TCG codes fail closed rather than becoming Pokémon', async () => {
  await assert.rejects(
    () => scanRetailer({ retailer: { ...inactiveRetailer, tcg: 'unknown-game' }, store: {} }),
    /Unsupported TCG code/,
  );
});
