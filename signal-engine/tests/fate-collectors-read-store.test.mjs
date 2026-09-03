import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readCollectorCollectionItemsFromStore,
  readCollectorVerifiedCardsByIdsFromStore,
  readCollectorVerifiedSetCardsFromStore,
} from '../src/trader/collection/collector-read-store.mjs';

function state(){
  return{
    traderCatalogue:{
      tcgs:{tcg:{id:'tcg',code:'pokemon',name:'Pokémon TCG'}},
      series:{series:{id:'series',tcgId:'tcg',name:'Era',verificationStatus:'verified'}},
      sets:{set:{id:'set',tcgId:'tcg',seriesId:'series',name:'Set',verificationStatus:'verified'}},
      printings:{
        p1:{id:'p1',name:'One',verificationStatus:'verified'},
        p2:{id:'p2',name:'Two',verificationStatus:'verified'},
        p3:{id:'p3',name:'Three',verificationStatus:'verified'},
      },
      cards:{
        c1:{id:'c1',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p1',collectorNumber:'1',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c2:{id:'c2',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p2',collectorNumber:'2',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
        c3:{id:'c3',tcgId:'tcg',seriesId:'series',setId:'set',printingId:'p3',collectorNumber:'3',variantCode:'standard',languageCode:'en',verificationStatus:'verified'},
      },
    },
    traderCollection:{
      collections:{mine:{id:'mine',userId:'user_1',tcgId:'tcg'}},
      items:{
        i1:{id:'i1',collectionId:'mine',fateCardId:'c1',quantity:1,tradeQuantity:0,copyState:'raw',conditionCode:'near_mint',status:'active',revision:1,createdAt:1,updatedAt:1},
        i2:{id:'i2',collectionId:'mine',fateCardId:'c2',quantity:2,tradeQuantity:0,copyState:'raw',conditionCode:'near_mint',status:'active',revision:1,createdAt:2,updatedAt:2},
        i3:{id:'i3',collectionId:'mine',fateCardId:'c3',quantity:3,tradeQuantity:0,copyState:'raw',conditionCode:'near_mint',status:'active',revision:1,createdAt:3,updatedAt:3},
      },grading:{},media:{},wants:{},events:[],itemSources:{},
    },
  };
}
function store(){const snapshot=state();return{read:async()=>snapshot};}

test('collection read reports true totals when its bounded payload is truncated',async()=>{
  const result=await readCollectorCollectionItemsFromStore(store(),{userId:'user_1',maxItems:2});
  assert.equal(result.truncated,true);
  assert.equal(result.totalItems,3);
  assert.equal(result.totalUnits,6);
  assert.equal(result.items.length,2);
});

test('canonical set read reports truncation instead of pretending the first identities are the whole set',async()=>{
  const result=await readCollectorVerifiedSetCardsFromStore(store(),{setId:'set',maxCards:2});
  assert.equal(result.truncated,true);
  assert.equal(result.totalCards,3);
  assert.equal(result.cards.length,2);
});

test('owned identity read keeps requested cardinality and explicit truncation',async()=>{
  const result=await readCollectorVerifiedCardsByIdsFromStore(store(),['c1','c2','c3'],{maxCards:2});
  assert.equal(result.requestedCount,3);
  assert.equal(result.truncated,true);
  assert.deepEqual(result.cards.map((card)=>card.fateCardId),['c1','c2']);
});
