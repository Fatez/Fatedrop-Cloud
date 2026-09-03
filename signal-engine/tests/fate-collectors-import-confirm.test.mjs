import test from 'node:test';
import assert from 'node:assert/strict';

import { confirmCollectrImportFromStore } from '../src/trader/collection/import/confirm.mjs';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

function catalogue({ ambiguous = false } = {}) {
  const cards = {
    c1:{id:'c1',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p1',collectorNumber:'4',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
    c2:{id:'c2',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p2',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
  };
  if (ambiguous) cards.c1_reverse={id:'c1_reverse',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p1',collectorNumber:'4',variantCode:'reverse-holo',languageCode:'en',verificationStatus:'verified'};
  return {
    tcgs:{tcg:{id:'tcg',code:'pokemon',name:'Pokémon TCG'}},
    series:{series:{id:'series',tcgId:'tcg',code:'base',name:'Base',verificationStatus:'verified'}},
    sets:{set:{id:'set',tcgId:'tcg',seriesId:'series',code:'base',name:'Base Set',printedTotal:2,total:2,verificationStatus:'verified'}},
    setSourceMappings:{},
    printings:{
      p1:{id:'p1',name:'Charizard',verificationStatus:'verified'},
      p2:{id:'p2',name:'Blastoise',verificationStatus:'verified'},
    },
    cards,
    cardSourceMappings:{},
    cardProvenance:{},
  };
}

function emptyCollection(){return{collections:{},items:{},grading:{},media:{},wants:{},events:[],itemSources:{}};}

function inMemoryStore({ ambiguous = false } = {}) {
  let state={traderCatalogue:catalogue({ambiguous}),traderCollection:emptyCollection()};
  return {
    async read(){return state;},
    async mutate(fn){
      const draft=structuredClone(state);
      const result=await fn(draft);
      state=draft;
      return result;
    },
  };
}

function charizardCsv({quantity=2,condition='NM',variant='Normal',purchase='100'}={}){
  return `Game,Set,Name,Card Number,Variant,Condition,Quantity,Purchase Price,Date Added\nPokémon,Base Set,Charizard,4,${variant},${condition},${quantity},${purchase},2026-01-01`;
}

function twoCardCsv(){
  return `Game,Set,Name,Card Number,Variant,Condition,Quantity\nPokémon,Base Set,Charizard,4,Normal,NM,1\nPokémon,Base Set,Blastoise,2,Normal,NM,1`;
}

test('confirmed exact Collectr row creates ownership and provenance together',async()=>{
  const store=inMemoryStore();
  const result=await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:charizardCsv(),observedAt:NOW});
  assert.equal(result.mode,'confirmed');
  assert.equal(result.summary.created,1);
  assert.equal(result.summary.held,0);
  const state=await store.read();
  assert.equal(Object.keys(state.traderCollection.items).length,1);
  assert.equal(Object.keys(state.traderCollection.itemSources).length,1);
  assert.equal(state.traderCollection.events.length,1);
  const item=Object.values(state.traderCollection.items)[0];
  assert.equal(item.fateCardId,'c1');
  assert.equal(item.quantity,2);
  assert.equal(item.conditionCode,'near_mint');
  assert.equal(Object.values(state.traderCollection.itemSources)[0].collectionItemId,item.id);
});

test('refresh updates the same imported item and repeating the same refresh is idempotent',async()=>{
  const store=inMemoryStore();
  await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:charizardCsv(),observedAt:NOW});
  const original=Object.values((await store.read()).traderCollection.items)[0];

  const refreshedCsv=charizardCsv({quantity:1,condition:'LP',purchase:'999'});
  const refreshed=await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:refreshedCsv,observedAt:NOW+1000});
  assert.equal(refreshed.summary.created,0);
  assert.equal(refreshed.summary.updated,1);
  let state=await store.read();
  let item=Object.values(state.traderCollection.items)[0];
  assert.equal(item.id,original.id);
  assert.equal(item.quantity,1);
  assert.equal(item.conditionCode,'lightly_played');
  assert.equal(item.revision,2);
  assert.equal(state.traderCollection.events.length,2);
  assert.equal(Object.keys(state.traderCollection.itemSources).length,2,'each distinct export batch keeps provenance without duplicating ownership');

  const repeated=await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:refreshedCsv,observedAt:NOW+2000});
  assert.equal(repeated.summary.created,0);
  assert.equal(repeated.summary.updated,0);
  assert.equal(repeated.summary.unchanged,1);
  state=await store.read();
  item=Object.values(state.traderCollection.items)[0];
  assert.equal(item.id,original.id);
  assert.equal(item.revision,2);
  assert.equal(state.traderCollection.events.length,2,'unchanged repeat does not invent an update event');
  assert.equal(Object.keys(state.traderCollection.itemSources).length,2,'same deterministic batch provenance is upserted');
});

test('rows missing from a later export are stale evidence and never auto-delete ownership',async()=>{
  const store=inMemoryStore();
  await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:twoCardCsv(),observedAt:NOW});
  assert.equal(Object.keys((await store.read()).traderCollection.items).length,2);

  const result=await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:charizardCsv({quantity:1,purchase:''}),observedAt:NOW+1000});
  assert.equal(result.summary.staleSourceRecords,1);
  const state=await store.read();
  assert.equal(Object.keys(state.traderCollection.items).length,2);
  assert.equal(Object.values(state.traderCollection.items).every((item)=>item.status==='active'),true);
});

test('ambiguous identity is held and writes no collection ownership',async()=>{
  const store=inMemoryStore({ambiguous:true});
  const csv=`Game,Set,Name,Card Number,Condition,Quantity\nPokémon,Base Set,Charizard,4,NM,1`;
  const result=await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:csv,observedAt:NOW});
  assert.equal(result.summary.created,0);
  assert.equal(result.summary.held,1);
  assert.equal(result.holds[0].reason,'exact_identity_ambiguous');
  const state=await store.read();
  assert.equal(Object.keys(state.traderCollection.items).length,0);
  assert.equal(Object.keys(state.traderCollection.itemSources).length,0);
});

test('refresh cannot reduce quantity below copies already marked for trade',async()=>{
  const store=inMemoryStore();
  await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:charizardCsv({quantity:3}),observedAt:NOW});
  await store.mutate((state)=>{
    const item=Object.values(state.traderCollection.items)[0];
    item.tradeQuantity=2;
  });
  const result=await confirmCollectrImportFromStore(store,{userId:'user_1',csvText:charizardCsv({quantity:1}),observedAt:NOW+1000});
  assert.equal(result.summary.updated,0);
  assert.equal(result.summary.held,1);
  assert.equal(result.holds[0].reason,'import_quantity_below_trade_quantity');
  const item=Object.values((await store.read()).traderCollection.items)[0];
  assert.equal(item.quantity,3);
  assert.equal(item.tradeQuantity,2);
});
