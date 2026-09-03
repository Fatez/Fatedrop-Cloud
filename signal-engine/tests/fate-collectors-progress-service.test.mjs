import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { getCollectionSetProgressFromStore } from '../src/trader/collection/progress-service.mjs';

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-progress-service-'));
  const store = new FileStore(path.join(dir, 'store.json'));
  await store.mutate((state) => {
    state.traderCatalogue = {
      tcgs:{ fdtcg_pokemon:{id:'fdtcg_pokemon',code:'pokemon',name:'Pokémon TCG'} },
      series:{ s1:{id:'s1',tcgId:'fdtcg_pokemon',name:'Era',verificationStatus:'verified'} },
      sets:{ set1:{id:'set1',tcgId:'fdtcg_pokemon',seriesId:'s1',name:'Set One',verificationStatus:'verified'} },
      setSourceMappings:{},
      printings:{
        p1:{id:'p1',name:'Alpha',verificationStatus:'verified'},
        p2:{id:'p2',name:'Beta',verificationStatus:'verified'},
      },
      cards:{
        c1:{id:'c1',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'set1',printingId:'p1',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified',verifiedAt:1},
        c2:{id:'c2',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'set1',printingId:'p2',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified',verifiedAt:1},
      },
      cardSourceMappings:{},cardProvenance:{},
    };
    state.traderCollection = {
      collections:{ col1:{id:'col1',userId:'u1',tcgId:'fdtcg_pokemon',name:'My Collection',visibility:'private'} },
      items:{ item1:{id:'item1',collectionId:'col1',fateCardId:'c1',quantity:1,tradeQuantity:0,copyState:'raw',conditionCode:'unknown',status:'active',revision:1,createdAt:1,updatedAt:1} },
      grading:{},media:{},wants:{},events:[],itemSources:{},
    };
  });
  return store;
}

test('service joins verified catalogue with owned collection items', async () => {
  const store = await seed();
  const progress = await getCollectionSetProgressFromStore(store,{userId:'u1',setId:'set1',preferredLanguageCode:'en'});
  assert.equal(progress.status,'available');
  assert.equal(progress.totalCount,2);
  assert.equal(progress.ownedCount,1);
  assert.equal(progress.missingCount,1);
  assert.equal(progress.completionPercent,50);
  assert.equal(progress.missingCards[0].fateCardId,'c2');
});

test('service fails closed for an unknown/unverified set', async () => {
  const store = await seed();
  const progress = await getCollectionSetProgressFromStore(store,{userId:'u1',setId:'missing'});
  assert.equal(progress.status,'unavailable');
  assert.equal(progress.reason,'verified_set_not_found');
  assert.equal(progress.completionPercent,null);
});
