import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { handleFateTraderCollection } from '../src/trader/collection/http.mjs';
import { hashFateDropSessionToken } from '../src/trader/auth.mjs';

const CARD='fdcard_verified';
const FLAGS=Object.freeze({enabled:true,catalogueEnabled:true,collectionEnabled:true,networkEnabled:false,matchingEnabled:false,huntsEnabled:false,messagingEnabled:false});
function request(method,url,body=null,headers={}){
  const raw=body==null?null:JSON.stringify(body);
  return {method,url,headers:{host:'localhost',...headers},async *[Symbol.asyncIterator](){if(raw)yield Buffer.from(raw);}};
}
function response(){return{status:null,body:null,writeHead(status){this.status=status;},end(raw){this.body=JSON.parse(raw);}};}
async function store(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatedrop-collection-http-'));const db=new FileStore(path.join(dir,'store.json'));
  await db.mutate((state)=>{state.traderCatalogue={tcgs:{fdtcg_pokemon:{id:'fdtcg_pokemon',code:'pokemon',name:'Pokémon TCG'}},series:{fdseries_1:{id:'fdseries_1',tcgId:'fdtcg_pokemon',name:'Era',verificationStatus:'verified'}},sets:{fdset_1:{id:'fdset_1',tcgId:'fdtcg_pokemon',seriesId:'fdseries_1',name:'Set',verificationStatus:'verified'}},setSourceMappings:{},printings:{fdprinting_1:{id:'fdprinting_1',name:'Examplemon',verificationStatus:'verified'}},cards:{[CARD]:{id:CARD,tcgId:'fdtcg_pokemon',seriesId:'fdseries_1',setId:'fdset_1',printingId:'fdprinting_1',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified',verifiedAt:1}},cardSourceMappings:{},cardProvenance:{}};});
  return db;
}
const user=async()=>({id:'user_1',fateId:'FD-TEST',username:'tester'});

test('session hash contract matches FateDrop website SHA-256 model',()=>{
  assert.equal(hashFateDropSessionToken('example-token'),'b6fbd675f98e2abd22d4ed29e22af10a53a67815c8f37a4fe730d75c5b71f60d');
});

test('collection routes fail closed when feature flag is dark',async()=>{
  const res=response();await handleFateTraderCollection(request('GET','/v1/collection'),res,{store:await store(),flags:{...FLAGS,collectionEnabled:false},resolveUser:user});
  assert.equal(res.status,404);assert.equal(res.body.ok,false);
});

test('collection routes require an authenticated FateDrop user',async()=>{
  const res=response();await handleFateTraderCollection(request('GET','/v1/collection'),res,{store:await store(),flags:FLAGS,resolveUser:async()=>null});
  assert.equal(res.status,401);assert.equal(res.body.error.code,'AUTH_REQUIRED');
});

test('authenticated user can create and read owned/tradeable collection state',async()=>{
  const db=await store();const createRes=response();
  await handleFateTraderCollection(request('POST','/v1/collection/items',{fateCardId:CARD,quantity:3,tradeQuantity:1,copyState:'raw',conditionCode:'near_mint'}),createRes,{store:db,flags:FLAGS,resolveUser:user});
  assert.equal(createRes.status,201);assert.equal(createRes.body.data.item.tradeQuantity,1);
  const listRes=response();await handleFateTraderCollection(request('GET','/v1/collection'),listRes,{store:db,flags:FLAGS,resolveUser:user});
  assert.equal(listRes.status,200);assert.equal(listRes.body.data.summary.totalCopies,3);assert.equal(listRes.body.data.summary.tradeableCopies,1);
});

test('exact Wants use canonical fateCardId and are visible in collection summary',async()=>{
  const db=await store();const putRes=response();
  await handleFateTraderCollection(request('PUT',`/v1/wants/${CARD}`,{quantity:2}),putRes,{store:db,flags:FLAGS,resolveUser:user});
  assert.equal(putRes.status,200);
  const listRes=response();await handleFateTraderCollection(request('GET','/v1/collection'),listRes,{store:db,flags:FLAGS,resolveUser:user});
  assert.equal(listRes.body.data.summary.wantedCards,1);assert.equal(listRes.body.data.wants[0].fateCardId,CARD);
});

test('collection item IDs remain owner scoped',async()=>{
  const db=await store();const createRes=response();
  await handleFateTraderCollection(request('POST','/v1/collection/items',{fateCardId:CARD,copyState:'raw',conditionCode:'unknown'}),createRes,{store:db,flags:FLAGS,resolveUser:user});
  const id=createRes.body.data.item.id;
  const foreignRes=response();
  await handleFateTraderCollection(request('PATCH',`/v1/collection/items/${id}`,{tradeQuantity:1,expectedRevision:1}),foreignRes,{store:db,flags:FLAGS,resolveUser:async()=>({id:'user_2'})});
  assert.equal(foreignRes.status,404);assert.equal(foreignRes.body.error.code,'COLLECTION_ITEM_NOT_FOUND');
});
