import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { normalizeCollectionCostBasis, upsertCollectionCostBasis, getCollectionCostBasis } from '../src/trader/collection/cost-basis.mjs';

async function seed() {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatedrop-cost-basis-'));
  const store=new FileStore(path.join(dir,'store.json'));
  await store.mutate((state)=>{
    state.traderCollection={
      collections:{c1:{id:'c1',userId:'u1',tcgId:'fdtcg_pokemon'}},
      items:{i1:{id:'i1',collectionId:'c1',fateCardId:'card1',quantity:2,status:'active'}},
      grading:{},media:{},wants:{},events:[],itemSources:{},costBasis:{},
    };
  });
  return store;
}

test('cost basis requires explicit currency and unit/lot scope',()=>{
  const value=normalizeCollectionCostBasis({amountMinor:1250,currencyCode:'gbp',priceScope:'unit',sourceName:'Collectr'});
  assert.equal(value.amountMinor,1250);
  assert.equal(value.currencyCode,'GBP');
  assert.equal(value.priceScope,'unit');
  assert.equal(value.sourceName,'collectr');
  assert.throws(()=>normalizeCollectionCostBasis({amountMinor:1,currencyCode:'GBP'}),/priceScope/);
});

test('owner can upsert and read purchase cost without affecting market truth',async()=>{
  const store=await seed();
  const saved=await upsertCollectionCostBasis(store,{userId:'u1',itemId:'i1',input:{amountMinor:2500,currencyCode:'GBP',priceScope:'lot',sourceName:'collectr'}});
  assert.equal(saved.amountMinor,2500);
  const read=await getCollectionCostBasis(store,{userId:'u1',itemId:'i1'});
  assert.equal(read.currencyCode,'GBP');
  assert.equal(await getCollectionCostBasis(store,{userId:'other',itemId:'i1'}),null);
});
