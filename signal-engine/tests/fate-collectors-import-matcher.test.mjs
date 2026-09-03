import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/stores/file-store.mjs';
import { matchCollectionImportRowsFromStore } from '../src/trader/collection/import/matcher.mjs';

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatedrop-import-matcher-'));
  const store = new FileStore(path.join(dir, 'store.json'));
  await store.mutate((state) => {
    state.traderCatalogue = {
      tcgs:{ fdtcg_pokemon:{id:'fdtcg_pokemon',code:'pokemon',name:'Pokémon TCG'} },
      series:{ s1:{id:'s1',tcgId:'fdtcg_pokemon',name:'Era',verificationStatus:'verified'} },
      sets:{ base:{id:'base',tcgId:'fdtcg_pokemon',seriesId:'s1',name:'Base Set',total:2,printedTotal:2,verificationStatus:'verified'} },
      setSourceMappings:{},
      printings:{
        p1:{id:'p1',name:'Charizard',verificationStatus:'verified'},
        p2:{id:'p2',name:'Blastoise',verificationStatus:'verified'},
      },
      cards:{
        c4:{id:'c4',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'base',printingId:'p1',collectorNumber:'4',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c4rh:{id:'c4rh',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'base',printingId:'p1',collectorNumber:'4',variantCode:'reverse-holo',languageCode:'en',verificationStatus:'verified'},
        c2:{id:'c2',tcgId:'fdtcg_pokemon',seriesId:'s1',setId:'base',printingId:'p2',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
      },cardSourceMappings:{},cardProvenance:{},
    };
  });
  return store;
}

function row(overrides={}) {
  return { sourceRecordKey:'r1',sourceRow:2,tcgCode:'pokemon',setName:'Base Set',cardName:'Charizard',collectorNumber:'4',variantLabel:'Normal',languageCode:'en',...overrides };
}

test('matcher resolves exact canonical identity from set, number, language and variant', async () => {
  const result = await matchCollectionImportRowsFromStore(await seed(),{rows:[row()]});
  assert.equal(result.summary.exact,1);
  assert.equal(result.matches[0].status,'exact');
  assert.equal(result.matches[0].fateCardId,'c4');
});

test('missing source variant becomes confirmation rather than a guessed exact identity', async () => {
  const result = await matchCollectionImportRowsFromStore(await seed(),{rows:[row({variantLabel:'',languageCode:null})]});
  assert.equal(result.summary.needsConfirmation,1);
  assert.equal(result.matches[0].reason,'exact_identity_ambiguous');
  assert.equal(result.matches[0].candidates.length,2);
});

test('collector number with printed total suffix still matches canonical numeric number', async () => {
  const result = await matchCollectionImportRowsFromStore(await seed(),{rows:[row({cardName:'Blastoise',collectorNumber:'002/102',variantLabel:'standard'})]});
  assert.equal(result.matches[0].status,'exact');
  assert.equal(result.matches[0].fateCardId,'c2');
});

test('unknown set stays unresolved', async () => {
  const result = await matchCollectionImportRowsFromStore(await seed(),{rows:[row({setName:'Not A Set'})]});
  assert.equal(result.matches[0].status,'unresolved');
  assert.equal(result.matches[0].reason,'set_not_found');
});
