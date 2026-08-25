import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFateTraderFlags } from '../src/trader/feature-flags.mjs';

test('Fate Trader feature gates remain dark by default',()=>{
  const flags=resolveFateTraderFlags({});
  assert.equal(flags.enabled,false);
  assert.equal(flags.catalogueEnabled,false);
  assert.equal(flags.collectionEnabled,false);
  assert.equal(flags.binderEnabled,false);
  assert.equal(flags.networkEnabled,false);
  assert.equal(flags.matchingEnabled,false);
});

test('Binder requires master, catalogue and collection before it can enable',()=>{
  const flags=resolveFateTraderFlags({FATE_TRADER_BINDER_ENABLED:'true'});
  assert.equal(flags.binderEnabled,false);
  const collectionOnly=resolveFateTraderFlags({
    FATE_TRADER_ENABLED:'true',FATE_TRADER_CATALOGUE_ENABLED:'true',FATE_TRADER_COLLECTION_ENABLED:'true',
  });
  assert.equal(collectionOnly.binderEnabled,false);
  const binder=resolveFateTraderFlags({
    FATE_TRADER_ENABLED:'true',FATE_TRADER_CATALOGUE_ENABLED:'true',FATE_TRADER_COLLECTION_ENABLED:'true',FATE_TRADER_BINDER_ENABLED:'true',
  });
  assert.equal(binder.binderEnabled,true);
  assert.equal(binder.networkEnabled,false);
});

test('Network and matching cannot leapfrog the Binder gate',()=>{
  const flags=resolveFateTraderFlags({
    FATE_TRADER_ENABLED:'true',FATE_TRADER_CATALOGUE_ENABLED:'true',FATE_TRADER_COLLECTION_ENABLED:'true',
    FATE_TRADER_NETWORK_ENABLED:'true',FATE_TRADER_MATCHING_ENABLED:'true',
  });
  assert.equal(flags.binderEnabled,false);
  assert.equal(flags.networkEnabled,false);
  assert.equal(flags.matchingEnabled,false);
});
