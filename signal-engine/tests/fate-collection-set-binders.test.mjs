import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  listTrackedCollectionSetBindersFromStore,
  setCollectionSetBinderTrackedInStore,
} from '../src/trader/collection/set-binder-store.mjs';

function store() {
  const state = {
    traderCatalogue: {
      tcgs:{ pokemon:{ id:'pokemon', code:'pokemon', name:'Pokémon TCG' } },
      series:{ sv:{ id:'sv', tcgId:'pokemon', name:'Scarlet & Violet', verificationStatus:'verified' } },
      sets:{ set151:{ id:'set151', tcgId:'pokemon', seriesId:'sv', name:'Pokémon 151', verificationStatus:'verified' } },
      printings:{},cards:{},setSourceMappings:{},cardSourceMappings:{},cardProvenance:{},
    },
  };
  return {
    async read() { return state; },
    async mutate(operation) { return operation(state); },
  };
}

test('a verified set can be tracked before the user owns a card and later removed', async () => {
  const subject = store();
  const tracked = await setCollectionSetBinderTrackedInStore(subject, { userId:'user-1', setId:'set151' });
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.set.name, 'Pokémon 151');
  assert.deepEqual((await listTrackedCollectionSetBindersFromStore(subject, { userId:'user-1' })).map((row) => row.setId), ['set151']);

  const removed = await setCollectionSetBinderTrackedInStore(subject, { userId:'user-1', setId:'set151', tracked:false });
  assert.equal(removed.tracked, false);
  assert.deepEqual(await listTrackedCollectionSetBindersFromStore(subject, { userId:'user-1' }), []);
});

test('unknown or staged sets cannot become collection binders', async () => {
  await assert.rejects(
    () => setCollectionSetBinderTrackedInStore(store(), { userId:'user-1', setId:'missing' }),
    (error) => error?.code === 'SET_IDENTITY_NOT_VERIFIED',
  );
});

test('set-binder migration stores preference only and is additive', async () => {
  const migration = await readFile(new URL('../database/2026-09-06-fate-collection-set-binders.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS fatedrop_collection_set_binders/);
  assert.match(migration, /UNIQUE\(user_id, set_id\)/);
  assert.match(migration, /status IN \('tracked', 'removed'\)/);
  assert.doesNotMatch(migration, /card_identity_id|quantity|known_value|completion_percent/i);
  assert.doesNotMatch(migration, /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b)/im);
});
