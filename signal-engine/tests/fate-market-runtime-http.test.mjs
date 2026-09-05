import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { createFateDropHttpServer } from '../src/http/fatedrop-server.mjs';
import { handleFateCollectors } from '../src/trader/collection/collectors-http.mjs';
import { handleFatePulse } from '../src/trader/value/http.mjs';

const FLAGS=Object.freeze({enabled:true,catalogueEnabled:true,collectionEnabled:true});
const USER=async()=>({id:'user_1',fateId:'FD-TEST'});

function request(method,url,body=null){
  const raw=body==null?null:JSON.stringify(body);
  return{method,url,headers:{host:'localhost'},async *[Symbol.asyncIterator](){if(raw)yield Buffer.from(raw);}};
}
function response(){return{status:null,body:null,writeHead(status){this.status=status;},end(raw){this.body=JSON.parse(raw);}};}
async function fileStore(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatedrop-market-runtime-'));
  return new FileStore(path.join(dir,'store.json'));
}

async function seedStore(){
  const store=await fileStore();
  await store.mutate((state)=>{
    state.traderCatalogue={
      tcgs:{tcg:{id:'tcg',code:'pokemon',name:'Pokémon TCG'}},
      series:{series:{id:'series',tcgId:'tcg',code:'sv',name:'Scarlet & Violet',verificationStatus:'verified'}},
      sets:{set:{id:'set',tcgId:'tcg',seriesId:'series',code:'base',name:'Base Set',printedTotal:2,total:2,verificationStatus:'verified'}},
      setSourceMappings:{},
      printings:{
        p1:{id:'p1',name:'Charizard',verificationStatus:'verified'},
        p2:{id:'p2',name:'Blastoise',verificationStatus:'verified'},
      },
      cards:{
        c1:{id:'c1',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p1',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c2:{id:'c2',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p2',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
      },
      cardSourceMappings:{
        m1:{id:'m1',cardIdentityId:'c1',sourceName:'cardmarket',sourceRecordId:'1',sourceVariantKey:'standard'},
        m2:{id:'m2',cardIdentityId:'c2',sourceName:'cardmarket',sourceRecordId:'2',sourceVariantKey:'standard'},
      },
      cardProvenance:{},
    };
    state.fateValueLab={
      ingestRuns:{},
      rejections:{},
      observations:{
        before:{id:'before',cardIdentityId:'c1',sourceName:'cardmarket',sourceVariantKey:'standard',marketSegmentKey:'standard',conditionCode:'unspecified',currencyCode:'EUR',marketDay:'2026-09-02',trendPrice:10,avg7d:10,observedAt:1},
        current:{id:'current',cardIdentityId:'c1',sourceName:'cardmarket',sourceVariantKey:'standard',marketSegmentKey:'standard',conditionCode:'unspecified',currencyCode:'EUR',marketDay:'2026-09-03',trendPrice:11,avg7d:11,observedAt:2},
        before2:{id:'before2',cardIdentityId:'c2',sourceName:'cardmarket',sourceVariantKey:'standard',marketSegmentKey:'standard',conditionCode:'unspecified',currencyCode:'EUR',marketDay:'2026-09-02',trendPrice:20,avg7d:20,observedAt:1},
        current2:{id:'current2',cardIdentityId:'c2',sourceName:'cardmarket',sourceVariantKey:'standard',marketSegmentKey:'standard',conditionCode:'unspecified',currencyCode:'EUR',marketDay:'2026-09-03',trendPrice:22,avg7d:22,observedAt:2},
      },
    };
    state.traderCollection={
      collections:{mine:{id:'mine',userId:'user_1',tcgId:'tcg'}},
      items:{owned:{id:'owned',collectionId:'mine',fateCardId:'c1',quantity:1,tradeQuantity:0,copyState:'raw',conditionCode:'near_mint',status:'active',revision:1,createdAt:1,updatedAt:1}},
      grading:{},media:{},wants:{},events:[],itemSources:{},
    };
  });
  return store;
}

async function withServer(store,fn){
  const server=createFateDropHttpServer({store,retailers:[]});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  try{await fn(`http://127.0.0.1:${server.address().port}`);}
  finally{await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}
}

test('FatePulse fails honestly into building state when canonical history is absent',async()=>{
  const res=response();
  await handleFatePulse(request('GET','/v1/market/pulse'),res,{store:await fileStore()});
  assert.equal(res.status,200);
  assert.equal(res.body.data.status,'building');
  assert.equal(res.body.data.reason,'canonical_card_schema_missing');
  assert.equal(res.body.data.intelligence.marketHeat,null);
});

test('FatePulse exposes factual exact-day movement while uncalibrated scores stay unknown',async()=>{
  const res=response();
  await handleFatePulse(request('GET','/v1/market/pulse?tcg=pokemon'),res,{store:await seedStore()});
  assert.equal(res.status,200);
  assert.equal(res.body.data.status,'available');
  assert.equal(res.body.data.pulse.movement.d1.medianPercent,10);
  assert.equal(res.body.data.pulse.movement.d7.contributors,0);
  assert.equal(res.body.data.pulse.direction.schemaVersion,'market-pulse-direction:1');
  assert.equal(res.body.data.pulse.direction.periods.d1.status,'available');
  assert.equal(res.body.data.pulse.direction.periods.d1.headlinePercent,10);
  assert.equal(res.body.data.pulse.direction.periods.d1.coverage.qualifyingSets,1);
  assert.equal(res.body.data.intelligence.volatility,null);
  assert.equal('cards' in res.body.data.pulse,false,'public summary does not expose a giant card payload');
});

test('Fate Collectors stays dark and authenticated at the route boundary',async()=>{
  const store=await seedStore();
  const dark=response();
  await handleFateCollectors(request('GET','/v1/collectors/summary'),dark,{store,flags:{...FLAGS,collectionEnabled:false},resolveUser:USER});
  assert.equal(dark.status,404);
  const anonymous=response();
  await handleFateCollectors(request('GET','/v1/collectors/summary'),anonymous,{store,flags:FLAGS,resolveUser:async()=>null});
  assert.equal(anonymous.status,401);
});

test('Fate Collectors reads owner-scoped completion without inventing a valuation',async()=>{
  const res=response();
  await handleFateCollectors(request('GET','/v1/collectors/summary?currency=EUR&language=en'),res,{store:await seedStore(),flags:FLAGS,resolveUser:USER});
  assert.equal(res.status,200);
  assert.equal(res.body.data.summary.cardUnits,1);
  assert.equal(res.body.data.summary.closestSet.completionPercent,50);
  assert.equal(res.body.data.summary.collection.totalValue,null);
  assert.equal(res.body.data.evidence.completeSetValuesConnected,false);
});

test('Collectr endpoint previews a user export without mutating ownership',async()=>{
  const store=await seedStore();
  const before=await store.read();
  const csv='Game,Set,Name,Card Number,Variant,Condition,Quantity\nPokémon,Base Set,Blastoise,2,Normal,NM,1';
  const res=response();
  await handleFateCollectors(request('POST','/v1/collectors/import/collectr/preview',{csvText:csv}),res,{store,flags:FLAGS,resolveUser:USER});
  assert.equal(res.status,200);
  assert.equal(res.body.data.mode,'preview_only');
  assert.equal(res.body.data.writesPerformed,false);
  assert.equal(res.body.data.preview.matched.exact,1);
  assert.deepEqual((await store.read()).traderCollection,before.traderCollection);
});

test('composed Cloud server dispatches Pulse and protects personal Collectors routes',async()=>{
  await withServer(await seedStore(),async(base)=>{
    const pulse=await fetch(`${base}/v1/market/pulse?tcg=pokemon`);
    assert.equal(pulse.status,200);
    assert.equal((await pulse.json()).data.status,'available');
    const collectors=await fetch(`${base}/v1/collectors/summary?currency=EUR&language=en`);
    assert.equal(collectors.status,404,'default-dark feature flags fail closed before authentication');
    assert.equal((await collectors.json()).error.code,'NOT_FOUND');
  });
});
