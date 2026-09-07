import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRetailSingleConnectorRegistry,
  retailSingleConnectorRegistry,
  runRetailSingleNetworkCycle,
} from '../src/trader/value/retail-single-connector-registry.mjs';
import { defaultRetailSingleNetworkEnabled } from '../src/config/env.mjs';

function connector(id, runCycle) {
  return Object.freeze({ id, retailer: Object.freeze({ id, name: id.toUpperCase() }), runCycle });
}

test('the proving connector uses the canonical retailer registry identity', () => {
  assert.deepEqual(retailSingleConnectorRegistry.list().map((item) => item.id), ['cob-and-pip']);
  assert.equal(retailSingleConnectorRegistry.require('cob-and-pip').retailer.name, 'Cob & Pip');
  assert.throws(() => retailSingleConnectorRegistry.require('cob-pip'), /Unknown retail-single connector/);
});

test('connector registry rejects duplicate and mismatched business identities', () => {
  assert.throws(() => createRetailSingleConnectorRegistry([
    connector('shop', async () => ({})),
    connector('shop', async () => ({})),
  ]), /Duplicate retail-single connector id/);
  assert.throws(() => createRetailSingleConnectorRegistry([{
    id: 'shop', retailer: { id: 'other-shop', name: 'Shop' }, runCycle: async () => ({}),
  }]), /canonical retailer id/);
});

test('network cycle aggregates clean retailers and isolates a failed connector', async () => {
  let active = 0;
  let peak = 0;
  const run = (result, failure = null) => async ({ write }) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    if (failure) throw failure;
    return { mode: write ? 'write' : 'dry-run', ...result };
  };
  const registry = createRetailSingleConnectorRegistry([
    connector('alpha', run({ candidates: 3, verified: 2, buyableVerified: 1, quarantined: 1 })),
    connector('bravo', run({}, new Error('feed unavailable'))),
    connector('charlie', run({ candidates: 4, verified: 4, buyableVerified: 3, quarantined: 0 })),
  ]);
  const result = await runRetailSingleNetworkCycle({ store: {}, registry, write: true, concurrency: 2, now: 1_788_800_000_000 });
  assert.equal(result.status, 'partial');
  assert.equal(result.completedCount, 2);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.totals, { candidates: 7, verified: 6, buyableVerified: 4, quarantined: 1 });
  assert.equal(result.connectors[1].error.message, 'feed unavailable');
  assert.ok(peak <= 2);
});

test('exact-card retailer reconciliation defaults on only for production Postgres', () => {
  assert.equal(defaultRetailSingleNetworkEnabled({ railwayEnvironmentName: 'production', store: 'postgres', databaseUrl: 'postgresql://db' }), true);
  assert.equal(defaultRetailSingleNetworkEnabled({ railwayEnvironmentName: 'preview', store: 'postgres', databaseUrl: 'postgresql://db' }), false);
  assert.equal(defaultRetailSingleNetworkEnabled({ railwayEnvironmentName: 'production', store: 'file', databaseUrl: 'postgresql://db' }), false);
  assert.equal(defaultRetailSingleNetworkEnabled({ railwayEnvironmentName: 'production', store: 'postgres', databaseUrl: '' }), false);
});
