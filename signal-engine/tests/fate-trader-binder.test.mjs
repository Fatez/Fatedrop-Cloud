import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import {
  addTradeBinderItem,
  getTradeBinder,
  getWantConstraints,
  patchTradeBinderItem,
  patchTradeBinderSettings,
  putWantConstraints,
} from '../src/trader/binder/service.mjs';

const USER='user_1';
const OTHER='user_2';
const TCG='fdtcg_pokemon';
const CARD='fdcard_verified';
const ITEM='fditem_owned';

async function seededStore({tradeQuantity=1}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatedrop-binder-'));
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

test('Binder accepts only owned collection items with positive trade quantity',async()=>{
  const store=await seededStore({tradeQuantity:0});
  await assert.rejects(
    addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM}}),
    (error)=>error.code==='COLLECTION_ITEM_NOT_TRADEABLE',
  );
  await assert.rejects(
    addTradeBinderItem(await seededStore(),{userId:OTHER,input:{collectionItemId:ITEM}}),
    (error)=>error.code==='COLLECTION_ITEM_NOT_TRADEABLE',
  );
});

test('Binder references Collection ownership and never duplicates quantity',async()=>{
  const store=await seededStore({tradeQuantity:1});
  const item=await addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM,tradeMode:'exact_wants_only'}});
  assert.equal(item.tradeQuantity,1);
  assert.equal(item.effectiveAvailable,true);
  assert.equal(item.fateCardId,CARD);
  await assert.rejects(
    addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM}}),
    (error)=>error.code==='BINDER_ITEM_EXISTS',
  );
});

test('Binder becomes effectively unavailable immediately when Collection tradeability disappears',async()=>{
  const store=await seededStore({tradeQuantity:1});
  await addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM}});
  await store.mutate((state)=>{state.traderCollection.items[ITEM].tradeQuantity=0;state.traderCollection.items[ITEM].revision+=1;});
  const snapshot=await getTradeBinder(store,{userId:USER,tcgId:TCG});
  assert.equal(snapshot.items.length,1);
  assert.equal(snapshot.items[0].status,'available');
  assert.equal(snapshot.items[0].effectiveAvailable,false);
  assert.equal(snapshot.items[0].staleReason,'collection_not_tradeable');
});

test('Network item visibility is opt-in behind network-visible Binder',async()=>{
  const store=await seededStore();
  await assert.rejects(
    addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM,visibility:'network'}}),
    (error)=>error.code==='BINDER_NOT_PUBLIC',
  );
  await patchTradeBinderSettings(store,{userId:USER,tcgId:TCG,input:{visibility:'network'}});
  const item=await addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM,visibility:'network'}});
  assert.equal(item.visibility,'network');
});

test('Binder settings use PATCH semantics without resetting omitted fields',async()=>{
  const store=await seededStore();
  await patchTradeBinderSettings(store,{userId:USER,tcgId:TCG,input:{visibility:'network',postalTradeAllowed:false,localTradeAllowed:true}});
  const changed=await patchTradeBinderSettings(store,{userId:USER,tcgId:TCG,input:{status:'paused'}});
  assert.equal(changed.status,'paused');
  assert.equal(changed.visibility,'network');
  assert.equal(changed.postalTradeAllowed,false);
  assert.equal(changed.localTradeAllowed,true);
});

test('Binder state machine prevents a traded item from reappearing as available',async()=>{
  const store=await seededStore();
  const item=await addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM}});
  const traded=await patchTradeBinderItem(store,{userId:USER,itemId:item.id,input:{status:'traded',expectedRevision:item.revision}});
  assert.equal(traded.status,'traded');
  await assert.rejects(
    patchTradeBinderItem(store,{userId:USER,itemId:item.id,input:{status:'available',expectedRevision:traded.revision}}),
    (error)=>error.code==='INVALID_BINDER_TRANSITION',
  );
});

test('Binder item mutation remains owner scoped',async()=>{
  const store=await seededStore();
  const item=await addTradeBinderItem(store,{userId:USER,input:{collectionItemId:ITEM}});
  const result=await patchTradeBinderItem(store,{userId:OTHER,itemId:item.id,input:{status:'withdrawn',expectedRevision:item.revision}});
  assert.equal(result,null);
});

test('Structured Wants require an active exact Want and validate grade semantics',async()=>{
  const store=await seededStore();
  const constraints=await putWantConstraints(store,{userId:USER,fateCardId:CARD,input:{copyState:'graded',minimumGrade:8,maximumGrade:10,acceptedGradingCompanies:['PSA','PSA','CGC'],postalTradeAllowed:true,localTradeAllowed:false}});
  assert.equal(constraints.copyState,'graded');
  assert.deepEqual(constraints.acceptedGradingCompanies,['PSA','CGC']);
  assert.equal(constraints.revision,1);
  const read=await getWantConstraints(store,{userId:USER,fateCardId:CARD});
  assert.equal(read.minimumGrade,8);

  await assert.rejects(
    putWantConstraints(store,{userId:USER,fateCardId:CARD,input:{copyState:'raw',minimumGrade:8,expectedRevision:1}}),
    TypeError,
  );
  await assert.rejects(
    putWantConstraints(store,{userId:OTHER,fateCardId:CARD,input:{copyState:'any'}}),
    (error)=>error.code==='WANT_NOT_FOUND',
  );
});

test('Structured Want optimistic revisions reject stale writes',async()=>{
  const store=await seededStore();
  const first=await putWantConstraints(store,{userId:USER,fateCardId:CARD,input:{copyState:'any'}});
  const second=await putWantConstraints(store,{userId:USER,fateCardId:CARD,input:{copyState:'raw',minimumConditionCode:'lightly_played',expectedRevision:first.revision}});
  assert.equal(second.revision,2);
  await assert.rejects(
    putWantConstraints(store,{userId:USER,fateCardId:CARD,input:{copyState:'graded',expectedRevision:first.revision}}),
    (error)=>error.code==='REVISION_CONFLICT',
  );
});
