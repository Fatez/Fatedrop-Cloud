import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { previewCollectrImportFromStore } from '../src/trader/collection/import/preview.mjs';

async function seed() {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatedrop-import-preview-'));
  const store=new FileStore(path.join(dir,'store.json'));
  await store.mutate((state)=>{
    state.traderCatalogue={
      tcgs:{fdtcg_pokemon:{id:'fdtcg_pokemon',code:'pokemon',name:'Pokémon TCG'}},
      series:{s1:{id:'s1',tcgId:'fdtcg_pokemon',name:'Era',verificationStatus:'verified'}},
      sets:{base:{id:'base',tcgId:'fdtcg_pokemon',seriesId:'s1',name:'Base Set',total:2,printedTotal:2,verificationStatus:'verified'}},
      setSourceMappings:{},
      printings:{p1:{id:'p1',name:'Charizard',verificationStatus:'verified'},p2:{id:'p2',name:'Blastoise',verificationStatus:'verified'}},
      cards:{
        c4:{id:'c4',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'base',printingId:'p1',collectorNumber:'4',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c2:{id:'c2',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'base',printingId:'p2',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
      },cardSourceMappings:{},cardProvenance:{},
    };
    state.traderCollection={collections:{},items:{},grading:{},media:{},wants:{},events:[],itemSources:{}};
  });
  return store;
}

test('preview runs CSV parse, canonical match and reconciliation without writing collection items',async()=>{
  const store=await seed();
  const csv=`Game,Set,Name,Card Number,Variant,Condition,Quantity\nPokémon,Base Set,Charizard,4,Normal,NM,1\nPokémon,Base Set,Blastoise,2,Normal,NM,1`;
  const preview=await previewCollectrImportFromStore(store,{userId:'u1',csvText:csv});
  assert.equal(preview.parsed.acceptedRows,2);
  assert.equal(preview.matched.exact,2);
  assert.equal(preview.plan.create,2);
  const state=await store.read();
  assert.equal(Object.keys(state.traderCollection.items).length,0);
});
