import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCollectionImportPlanInStore } from '../src/trader/collection/import/apply-plan.mjs';

function createPlan() {
  return {
    creates:[{
      sourceRecordKey:'collectr-row-1',
      match:{status:'exact',fateCardId:'card-1',row:{sourceRecordKey:'collectr-row-1'}},
      collectionInput:{fateCardId:'card-1',quantity:2,tradeQuantity:0,copyState:'raw',conditionCode:'near_mint'},
    }],
    updates:[],
    unchanged:[],
    holds:[{reason:'printing_ambiguous'}],
  };
}

function fakePostgres({failSource=false}={}) {
  const calls=[];
  const client={
    async query(sql,params=[]) {
      const text=String(sql);
      calls.push({text,params});
      if(text==='BEGIN'||text==='COMMIT'||text==='ROLLBACK')return{rows:[],rowCount:0};
      if(text.includes('pg_advisory_xact_lock'))return{rows:[{}],rowCount:1};
      if(text.includes('SELECT tcg_id FROM fatedrop_card_identities'))return{rows:[{tcg_id:'fdtcg_pokemon'}],rowCount:1};
      if(text.includes('INSERT INTO fatedrop_collection_item_sources')){
        if(failSource)throw new Error('source insert failed');
        return{rows:[{id:'source-1'}],rowCount:1};
      }
      return{rows:[],rowCount:1};
    },
    release(){calls.push({text:'RELEASE',params:[]});},
  };
  return{
    calls,
    store:{async pool(){return{async connect(){return client;}};}},
  };
}

test('confirmed Collectr create uses one transaction, user lock, ownership event and source provenance',async()=>{
  const fixture=fakePostgres();
  const result=await applyCollectionImportPlanInStore(fixture.store,{
    userId:'user-1',
    plan:createPlan(),
    importBatchKey:'collectr:test-batch',
  });
  assert.equal(result.created.length,1);
  assert.deepEqual(result.updated,[]);
  assert.equal(fixture.calls[0].text,'BEGIN');
  assert.match(fixture.calls[1].text,/pg_advisory_xact_lock/);
  assert.equal(fixture.calls.some((call)=>call.text.includes('INSERT INTO fatedrop_collection_items')),true);
  assert.equal(fixture.calls.some((call)=>call.text.includes('INSERT INTO fatedrop_collection_item_events')),true);
  assert.equal(fixture.calls.some((call)=>call.text.includes('INSERT INTO fatedrop_collection_item_sources')),true);
  const commitIndex=fixture.calls.findIndex((call)=>call.text==='COMMIT');
  const sourceIndex=fixture.calls.findIndex((call)=>call.text.includes('INSERT INTO fatedrop_collection_item_sources'));
  assert.ok(commitIndex>sourceIndex,'source provenance must persist before commit');
});

test('source provenance failure rolls the whole Postgres Collectr import back',async()=>{
  const fixture=fakePostgres({failSource:true});
  await assert.rejects(()=>applyCollectionImportPlanInStore(fixture.store,{
    userId:'user-1',
    plan:createPlan(),
    importBatchKey:'collectr:test-batch',
  }),/source insert failed/);
  assert.equal(fixture.calls.some((call)=>call.text==='ROLLBACK'),true);
  assert.equal(fixture.calls.some((call)=>call.text==='COMMIT'),false);
});

test('held Collectr rows are not part of the ownership write plan',async()=>{
  const fixture=fakePostgres();
  const result=await applyCollectionImportPlanInStore(fixture.store,{
    userId:'user-1',
    plan:{creates:[],updates:[],unchanged:[],holds:[{reason:'ambiguous'}]},
    importBatchKey:'collectr:test-held',
  });
  assert.deepEqual(result,{created:[],updated:[],unchanged:[]});
  assert.equal(fixture.calls.some((call)=>call.text.includes('INSERT INTO fatedrop_collection_items')),false);
  assert.equal(fixture.calls.some((call)=>call.text.includes('INSERT INTO fatedrop_collection_item_sources')),false);
});
