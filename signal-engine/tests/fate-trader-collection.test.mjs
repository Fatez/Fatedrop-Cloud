import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import {
  addCollectionMediaReference,
  createCollectionItemInStore,
  listCollectionItemsFromStore,
  listExactWantsFromStore,
  removeCollectionItemFromStore,
  removeExactWantFromStore,
  updateCollectionItemInStore,
  upsertExactWantInStore,
} from '../src/trader/collection/store.mjs';
import { normalizeCollectionItemInput } from '../src/trader/collection/model.mjs';

const USER_ID = 'user_test_1';
const VERIFIED_CARD = 'fdcard_verified';
const STAGED_CARD = 'fdcard_staged';

async function seededStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-collection-'));
  const store = new FileStore(path.join(dir, 'store.json'));
  await store.mutate((state) => {
    state.traderCatalogue = {
      tcgs: { fdtcg_pokemon: { id:'fdtcg_pokemon',code:'pokemon',name:'Pokémon TCG' } },
      series: { fdseries_1: { id:'fdseries_1',tcgId:'fdtcg_pokemon',name:'Example Era',verificationStatus:'verified' } },
      sets: { fdset_1: { id:'fdset_1',tcgId:'fdtcg_pokemon',seriesId:'fdseries_1',name:'Example Set',verificationStatus:'verified' } },
      setSourceMappings: {},
      printings: { fdprinting_1: { id:'fdprinting_1',name:'Examplemon',rarity:'Rare',supertype:'Pokemon',verificationStatus:'verified' } },
      cards: {
        [VERIFIED_CARD]: { id:VERIFIED_CARD,tcgId:'fdtcg_pokemon',seriesId:'fdseries_1',setId:'fdset_1',printingId:'fdprinting_1',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified',verifiedAt:1 },
        [STAGED_CARD]: { id:STAGED_CARD,tcgId:'fdtcg_pokemon',seriesId:'fdseries_1',setId:'fdset_1',printingId:'fdprinting_1',collectorNumber:'1',variantCode:'reverse-holo',languageCode:'en',verificationStatus:'staged',verifiedAt:null },
      },
      cardSourceMappings: {},
      cardProvenance: {},
    };
  });
  return store;
}

test('raw collection item can represent quantity with only part available to trade', async () => {
  const store = await seededStore();
  const item = await createCollectionItemInStore(store, {
    userId: USER_ID,
    input: { fateCardId:VERIFIED_CARD,quantity:3,tradeQuantity:1,copyState:'raw',conditionCode:'near_mint' },
  });
  assert.equal(item.quantity, 3);
  assert.equal(item.tradeQuantity, 1);
  assert.equal(item.availableToTrade, true);
  assert.equal(item.conditionCode, 'near_mint');
  assert.equal((await listCollectionItemsFromStore(store,{userId:USER_ID})).length, 1);
});

test('graded items are one physical object and require grading evidence', () => {
  assert.throws(() => normalizeCollectionItemInput({
    fateCardId:VERIFIED_CARD,quantity:2,copyState:'graded',grading:{gradingCompany:'PSA',gradeLabel:'10'},
  }), /quantity 1/);
  assert.throws(() => normalizeCollectionItemInput({
    fateCardId:VERIFIED_CARD,copyState:'graded',
  }), /grading details are required/);
  const valid = normalizeCollectionItemInput({
    fateCardId:VERIFIED_CARD,copyState:'graded',tradeQuantity:1,grading:{gradingCompany:'PSA',gradeLabel:'10',gradeValue:10,certificationNumber:'123'},
  });
  assert.equal(valid.quantity,1);
  assert.equal(valid.conditionCode,null);
  assert.equal(valid.grading.certificationStatus,'unverified');
});

test('collection rejects card identities that are not verified', async () => {
  const store = await seededStore();
  await assert.rejects(() => createCollectionItemInStore(store, {
    userId:USER_ID,input:{fateCardId:STAGED_CARD,copyState:'raw',conditionCode:'near_mint'},
  }), (error) => error.code === 'CARD_IDENTITY_NOT_VERIFIED');
});

test('collection updates are optimistic and append audit history', async () => {
  const store = await seededStore();
  const item = await createCollectionItemInStore(store,{userId:USER_ID,input:{fateCardId:VERIFIED_CARD,quantity:2,tradeQuantity:0,copyState:'raw',conditionCode:'near_mint'}});
  const updated = await updateCollectionItemInStore(store,{userId:USER_ID,itemId:item.id,input:{tradeQuantity:1},expectedRevision:1});
  assert.equal(updated.revision,2);
  assert.equal(updated.tradeQuantity,1);
  await assert.rejects(() => updateCollectionItemInStore(store,{userId:USER_ID,itemId:item.id,input:{tradeQuantity:2},expectedRevision:1}), (error) => error.code === 'REVISION_CONFLICT');
  const state = await store.read();
  assert.deepEqual(state.traderCollection.events.map((event)=>event.eventType), ['created','trade_quantity_changed']);
});

test('remove is soft-delete and removes the item from active collection reads', async () => {
  const store = await seededStore();
  const item = await createCollectionItemInStore(store,{userId:USER_ID,input:{fateCardId:VERIFIED_CARD,copyState:'raw',conditionCode:'unknown',tradeQuantity:1}});
  assert.equal(await removeCollectionItemFromStore(store,{userId:USER_ID,itemId:item.id,expectedRevision:1}),true);
  assert.equal((await listCollectionItemsFromStore(store,{userId:USER_ID})).length,0);
  const state=await store.read();
  assert.equal(state.traderCollection.items[item.id].status,'removed');
  assert.equal(state.traderCollection.items[item.id].tradeQuantity,0);
});

test('exact card wants share canonical fateCardId and can be deactivated', async () => {
  const store=await seededStore();
  const want=await upsertExactWantInStore(store,{userId:USER_ID,fateCardId:VERIFIED_CARD,input:{quantity:2}});
  assert.equal(want.cardIdentityId,VERIFIED_CARD);
  const listed=await listExactWantsFromStore(store,{userId:USER_ID});
  assert.equal(listed.length,1);
  assert.equal(listed[0].fateCardId,VERIFIED_CARD);
  assert.equal(await removeExactWantFromStore(store,{userId:USER_ID,fateCardId:VERIFIED_CARD}),true);
  assert.equal((await listExactWantsFromStore(store,{userId:USER_ID})).length,0);
});

test('media references attach only to an owned active collection item', async () => {
  const store=await seededStore();
  const item=await createCollectionItemInStore(store,{userId:USER_ID,input:{fateCardId:VERIFIED_CARD,copyState:'raw',conditionCode:'near_mint'}});
  const media=await addCollectionMediaReference(store,{userId:USER_ID,itemId:item.id,mediaRole:'front',storageKey:'trader/test/front.webp'});
  assert.equal(media.collectionItemId,item.id);
  assert.equal(media.mediaRole,'front');
  assert.equal(await addCollectionMediaReference(store,{userId:'other',itemId:item.id,mediaRole:'front',storageKey:'x'}),null);
});
