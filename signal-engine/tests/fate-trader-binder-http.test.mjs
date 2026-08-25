import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { handleFateTraderBinder } from '../src/trader/binder/http.mjs';

const USER='user_1';
const OTHER='user_2';
const TCG='fdtcg_pokemon';
const CARD='fdcard_verified';
const ITEM='fditem_owned';
const FLAGS=Object.freeze({
  enabled:true,catalogueEnabled:true,collectionEnabled:true,binderEnabled:true,
  networkEnabled:false,matchingEnabled:false,huntsEnabled:false,messagingEnabled:false,
});

function request(method,url,body=null,headers={}){
  const raw=body==null?null:JSON.stringify(body);
  return {method,url,headers:{host:'localhost',...headers},async *[Symbol.asyncIterator](){if(raw)yield Buffer.from(raw);}};
}
function response(){return{status:null,body:null,writeHead(status){this.status=status;},end(raw){this.body=JSON.parse(raw);}};}
const user=async()=>({id:USER,fateId:'FD-TEST',username:'tester'});

async function seededStore({tradeQuantity=1}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatedrop-binder-http-'));
  const store=new FileStore(path.join(dir,'store.json'));
  await store.mutate((state)=>{
    state.traderCollection={
      collections:{fdcollection_1:{id:'fdcollection_1',userId:USER,tcgId:TCG,name:'My Collection',visibility:'private',createdAt:1,updatedAt:1}},
      items:{[ITEM]:{id:ITEM,collectionId:'fdcollection_1',fateCardId:CARD,quantity:2,tradeQuantity,copyState:'raw',conditionCode:'near_mint',notes:null,status:'active',revision:1,createdAt:1,updatedAt:1}},
      grading:{},media:{},
      wants:{fdwant_1:{id:'fdwant_1',userId:USER,cardIdentityId:CARD,quantity:1,active:true,createdAt:1,updatedAt:1}},
      events:[],
    };
  });
  return store;
}

test('Trader Binder routes stay dark behind their feature gate',async()=>{
  const res=response();
  await handleFateTraderBinder(request('GET','/v1/trader/binder'),res,{store:await seededStore(),flags:{...FLAGS,binderEnabled:false},resolveUser:user});
  assert.equal(res.status,404);
  assert.equal(res.body.error.code,'NOT_FOUND');
});

test('Trader Binder routes require the existing FateDrop session',async()=>{
  const res=response();
  await handleFateTraderBinder(request('GET','/v1/trader/binder'),res,{store:await seededStore(),flags:FLAGS,resolveUser:async()=>null});
  assert.equal(res.status,401);
  assert.equal(res.body.error.code,'AUTH_REQUIRED');
});

test('authenticated user can configure Binder and add a tradeable owned item',async()=>{
  const store=await seededStore();
  const settings=response();
  await handleFateTraderBinder(request('PATCH','/v1/trader/binder',{visibility:'network',localTradeAllowed:true,postalTradeAllowed:false}),settings,{store,flags:FLAGS,resolveUser:user});
  assert.equal(settings.status,200);
  assert.equal(settings.body.data.binder.visibility,'network');

  const create=response();
  await handleFateTraderBinder(request('POST','/v1/trader/binder/items',{collectionItemId:ITEM,visibility:'network',tradeMode:'exact_wants_only'}),create,{store,flags:FLAGS,resolveUser:user});
  assert.equal(create.status,201);
  assert.equal(create.body.data.item.effectiveAvailable,true);

  const list=response();
  await handleFateTraderBinder(request('GET','/v1/trader/binder'),list,{store,flags:FLAGS,resolveUser:user});
  assert.equal(list.status,200);
  assert.equal(list.body.data.items.length,1);
});

test('Binder HTTP fails closed when Collection no longer says the item is tradeable',async()=>{
  const store=await seededStore({tradeQuantity:0});
  const res=response();
  await handleFateTraderBinder(request('POST','/v1/trader/binder/items',{collectionItemId:ITEM}),res,{store,flags:FLAGS,resolveUser:user});
  assert.equal(res.status,409);
  assert.equal(res.body.error.code,'COLLECTION_ITEM_NOT_TRADEABLE');
});

test('Binder item IDs remain owner scoped through HTTP',async()=>{
  const store=await seededStore();
  const create=response();
  await handleFateTraderBinder(request('POST','/v1/trader/binder/items',{collectionItemId:ITEM}),create,{store,flags:FLAGS,resolveUser:user});
  const id=create.body.data.item.id;
  const foreign=response();
  await handleFateTraderBinder(request('PATCH',`/v1/trader/binder/items/${id}`,{status:'withdrawn',expectedRevision:1}),foreign,{store,flags:FLAGS,resolveUser:async()=>({id:OTHER})});
  assert.equal(foreign.status,404);
  assert.equal(foreign.body.error.code,'BINDER_ITEM_NOT_FOUND');
});

test('structured Want route adds constraints only to an existing exact Want',async()=>{
  const store=await seededStore();
  const put=response();
  await handleFateTraderBinder(request('PUT',`/v1/trader/wants/${CARD}`,{copyState:'graded',minimumGrade:8,maximumGrade:10,postalTradeAllowed:true,localTradeAllowed:false}),put,{store,flags:FLAGS,resolveUser:user});
  assert.equal(put.status,200);
  assert.equal(put.body.data.constraints.minimumGrade,8);

  const list=response();
  await handleFateTraderBinder(request('GET','/v1/trader/wants'),list,{store,flags:FLAGS,resolveUser:user});
  assert.equal(list.status,200);
  assert.equal(list.body.data.wants[0].constraints.copyState,'graded');

  const missing=response();
  await handleFateTraderBinder(request('PUT',`/v1/trader/wants/${CARD}`,{copyState:'any'}),missing,{store,flags:FLAGS,resolveUser:async()=>({id:OTHER})});
  assert.equal(missing.status,404);
  assert.equal(missing.body.error.code,'WANT_NOT_FOUND');
});

test('Fate Trader v1 rejects unsupported TCGs instead of fabricating identity scope',async()=>{
  const res=response();
  await handleFateTraderBinder(request('GET','/v1/trader/binder?tcg=magic'),res,{store:await seededStore(),flags:FLAGS,resolveUser:user});
  assert.equal(res.status,400);
  assert.equal(res.body.error.code,'TCG_NOT_SUPPORTED');
});
