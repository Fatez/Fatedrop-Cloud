import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { auditCollectorCatalogueFromStore } from '../src/trader/catalogue/collector-readiness.mjs';

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-catalogue-readiness-'));
  const store = new FileStore(path.join(dir, 'store.json'));
  await store.mutate((state) => {
    state.traderCatalogue = {
      tcgs:{ fdtcg_pokemon:{id:'fdtcg_pokemon',code:'pokemon',name:'Pokémon TCG'} },
      series:{ s1:{id:'s1',tcgId:'fdtcg_pokemon',name:'Era',verificationStatus:'verified'} },
      sets:{
        ready:{id:'ready',tcgId:'fdtcg_pokemon',seriesId:'s1',name:'Ready Set',total:2,printedTotal:2,verificationStatus:'verified'},
        short:{id:'short',tcgId:'fdtcg_pokemon',seriesId:'s1',name:'Short Set',total:3,printedTotal:3,verificationStatus:'verified'},
        unknown:{id:'unknown',tcgId:'fdtcg_pokemon',seriesId:'s1',name:'Unknown Set',verificationStatus:'verified'},
      },
      setSourceMappings:{},
      printings:{
        p1:{id:'p1',name:'A',verificationStatus:'verified'},p2:{id:'p2',name:'B',verificationStatus:'verified'},
        p3:{id:'p3',name:'C',verificationStatus:'verified'},p4:{id:'p4',name:'D',verificationStatus:'verified'},
        p5:{id:'p5',name:'E',verificationStatus:'verified'},
      },
      cards:{
        c1:{id:'c1',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'ready',printingId:'p1',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c2:{id:'c2',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'ready',printingId:'p2',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c3:{id:'c3',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'short',printingId:'p3',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c4:{id:'c4',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'short',printingId:'p4',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c5:{id:'c5',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'unknown',printingId:'p5',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
      },cardSourceMappings:{},cardProvenance:{},
    };
  });
  return store;
}

test('audit clearly separates collector-ready and incomplete/unknown sets', async () => {
  const audit = await auditCollectorCatalogueFromStore(await seed(),{tcgCode:'pokemon'});
  assert.equal(audit.summary.totalVerifiedSets,3);
  assert.equal(audit.summary.collectorReadySets,1);
  assert.equal(audit.summary.incompleteSets,1);
  assert.equal(audit.summary.unknownSets,1);
  assert.equal(audit.sets.find((set)=>set.setId==='ready').collectorReady,true);
  assert.equal(audit.sets.find((set)=>set.setId==='short').missingCanonicalCount,1);
});
