import test from 'node:test';
import assert from 'node:assert/strict';

import { handleFateCollectors } from '../src/trader/collection/collectors-http.mjs';

const FLAGS=Object.freeze({enabled:true,catalogueEnabled:true,collectionEnabled:true});
const USER=async()=>({id:'user_1',fateId:'FD-TEST'});

function request(body){
  const raw=JSON.stringify(body);
  return{method:'POST',url:'/v1/collectors/import/collectr/confirm',headers:{host:'localhost'},async *[Symbol.asyncIterator](){yield Buffer.from(raw);}};
}
function response(){return{status:null,body:null,writeHead(status){this.status=status;},end(raw){this.body=JSON.parse(raw);}};}
function store(){
  let state={
    traderCatalogue:{
      tcgs:{tcg:{id:'tcg',code:'pokemon',name:'Pokémon TCG'}},
      series:{series:{id:'series',tcgId:'tcg',code:'base',name:'Base',verificationStatus:'verified'}},
      sets:{set:{id:'set',tcgId:'tcg',seriesId:'series',code:'base',name:'Base Set',printedTotal:1,total:1,verificationStatus:'verified'}},
      setSourceMappings:{},
      printings:{p1:{id:'p1',name:'Charizard',verificationStatus:'verified'}},
      cards:{c1:{id:'c1',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p1',collectorNumber:'4',variantCode:'standard',languageCode:'en',verificationStatus:'verified'}},
      cardSourceMappings:{},cardProvenance:{},
    },
    traderCollection:{collections:{},items:{},grading:{},media:{},wants:{},events:[],itemSources:{}},
  };
  return{
    async read(){return state;},
    async mutate(fn){const draft=structuredClone(state);const result=await fn(draft);state=draft;return result;},
  };
}

const CSV=`Game,Set,Name,Card Number,Variant,Condition,Quantity\nPokémon,Base Set,Charizard,4,Normal,NM,1`;

test('confirmed import requires an authenticated FateDrop user',async()=>{
  const res=response();
  await handleFateCollectors(request({csvText:CSV}),res,{store:store(),flags:FLAGS,resolveUser:async()=>null});
  assert.equal(res.status,401);
  assert.equal(res.body.error.code,'AUTH_REQUIRED');
});

test('confirmed import re-matches server-side and creates owner-scoped collection ownership',async()=>{
  const data=store();
  const res=response();
  await handleFateCollectors(request({csvText:CSV}),res,{store:data,flags:FLAGS,resolveUser:USER});
  assert.equal(res.status,200);
  assert.equal(res.body.data.mode,'confirmed');
  assert.equal(res.body.data.result.summary.created,1);
  assert.equal(res.body.data.result.summary.held,0);
  const state=await data.read();
  assert.equal(Object.keys(state.traderCollection.items).length,1);
  assert.equal(Object.keys(state.traderCollection.itemSources).length,1);
  assert.equal(Object.values(state.traderCollection.collections)[0].userId,'user_1');
});

test('repeating the same confirmed export does not duplicate ownership',async()=>{
  const data=store();
  const first=response();
  await handleFateCollectors(request({csvText:CSV}),first,{store:data,flags:FLAGS,resolveUser:USER});
  const second=response();
  await handleFateCollectors(request({csvText:CSV}),second,{store:data,flags:FLAGS,resolveUser:USER});
  assert.equal(second.status,200);
  assert.equal(second.body.data.result.summary.created,0);
  assert.equal(second.body.data.result.summary.updated,0);
  assert.equal(second.body.data.result.summary.unchanged,1);
  const state=await data.read();
  assert.equal(Object.keys(state.traderCollection.items).length,1);
  assert.equal(state.traderCollection.events.length,1);
});
