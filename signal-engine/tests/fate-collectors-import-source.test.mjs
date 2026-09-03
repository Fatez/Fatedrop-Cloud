import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listCollectionItemImportSources,
  makeCollectionItemSourceId,
  normalizeCollectionImportSource,
  recordCollectionItemImportSource,
} from '../src/trader/collection/import-source.mjs';

function storeFor(userId = 'user-1') {
  const state = {
    traderCollection:{
      collections:{ c1:{ id:'c1',userId } },
      items:{ i1:{ id:'i1',collectionId:'c1',status:'active' } },
      grading:{},
      media:{},
      wants:{},
      events:[],
      itemSources:{},
    },
  };
  return {
    read: async () => state,
    mutate: async (fn) => fn(state),
  };
}

test('source identity is importer agnostic and deterministic', () => {
  const source = normalizeCollectionImportSource({
    sourceName:'Collectr',
    sourceRecordKey:'pokemon|sv1|001|standard',
    importBatchKey:'csv-sha-123',
    observedAt:123,
  });
  assert.equal(source.sourceName,'collectr');
  assert.equal(makeCollectionItemSourceId('i1',source),makeCollectionItemSourceId('i1',source));
});

test('records idempotent import provenance only for an owned active item', async () => {
  const store = storeFor();
  const source = {
    sourceName:'collectr',
    sourceRecordKey:'one-piece|op01|001',
    importBatchKey:'batch-a',
    observedAt:10,
  };
  const first = await recordCollectionItemImportSource(store,{ userId:'user-1',itemId:'i1',source });
  const second = await recordCollectionItemImportSource(store,{
    userId:'user-1',
    itemId:'i1',
    source:{ ...source,observedAt:20 },
  });
  assert.equal(first.id,second.id);
  const listed = await listCollectionItemImportSources(store,{ userId:'user-1',itemId:'i1' });
  assert.equal(listed.length,1);
  assert.equal(listed[0].sourceName,'collectr');
  assert.equal(listed[0].observedAt,20);
  assert.equal(await recordCollectionItemImportSource(store,{ userId:'other',itemId:'i1',source }),null);
});

test('rejects provenance without a deterministic source record key', () => {
  assert.throws(() => normalizeCollectionImportSource({ sourceName:'collectr' }),/sourceRecordKey is required/);
});
