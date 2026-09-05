import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFateCollectorPersonalPulse } from '../src/trader/collection/personal-pulse.mjs';

const collectionItems=[
  {fateCardId:'card-a',quantity:2,status:'owned'},
  {fateCardId:'card-b',quantity:1,status:'owned'},
  {fateCardId:'card-c',quantity:1,status:'owned'},
  {fateCardId:'card-d',quantity:1,status:'owned'},
  {fateCardId:'card-removed',quantity:1,status:'removed'},
];
const cards=[
  {fateCardId:'card-a',name:'Alpha',tcgCode:'pokemon',setId:'set-a',setName:'Set A',collectorNumber:'001',variantCode:'standard',languageCode:'en'},
  {fateCardId:'card-b',name:'Beta',tcgCode:'pokemon',setId:'set-a',setName:'Set A',collectorNumber:'002',variantCode:'standard',languageCode:'en'},
  {fateCardId:'card-c',name:'Gamma',tcgCode:'pokemon',setId:'set-b',setName:'Set B',collectorNumber:'003',variantCode:'holo',languageCode:'en'},
  {fateCardId:'card-d',name:'Delta',tcgCode:'one-piece',setId:'set-c',setName:'Set C',collectorNumber:'004',variantCode:'standard',languageCode:'en'},
];
function price(cardIdentityId,d7,d30){
  return {cardIdentityId,available:true,price:{amount:10,currencyCode:'EUR'},movement:{
    d7:{available:true,absolute:d7/10,percent:d7},
    d30:{available:true,absolute:d30/10,percent:d30},
  }};
}
const prices=[
  price('card-a',12,25),
  price('card-b',4,-8),
  price('card-c',-7,-15),
  price('card-d',22,3),
  price('card-not-owned',99,99),
];

test('personal pulse ranks only owned exact identities and caps top/bottom lists',()=>{
  const pulse=buildFateCollectorPersonalPulse({collectionItems,cards,prices,limit:3});
  assert.equal(pulse.schemaVersion,'collector-personal-pulse:1');
  assert.equal(pulse.ownedIdentityCount,4);
  assert.equal(pulse.verifiedOwnedIdentityCount,4);
  assert.deepEqual(pulse.periods.d7.risers.map((row)=>row.cardIdentityId),['card-d','card-a','card-b']);
  assert.deepEqual(pulse.periods.d7.decliners.map((row)=>row.cardIdentityId),['card-c']);
  assert.deepEqual(pulse.periods.d30.risers.map((row)=>row.cardIdentityId),['card-a','card-d']);
  assert.deepEqual(pulse.periods.d30.decliners.map((row)=>row.cardIdentityId),['card-c','card-b']);
  assert.equal(pulse.periods.d7.risers[1].quantity,2);
  assert.equal(pulse.periods.d7.risers.some((row)=>row.cardIdentityId==='card-not-owned'),false);
});

test('missing trustworthy history stays building instead of becoming fake zero movement',()=>{
  const pulse=buildFateCollectorPersonalPulse({collectionItems:[{fateCardId:'card-a',quantity:1}],cards:[cards[0]],prices:[{cardIdentityId:'card-a',available:false,movement:{}}]});
  assert.equal(pulse.periods.d7.status,'building');
  assert.equal(pulse.periods.d7.reason,'owned_price_history_insufficient');
  assert.deepEqual(pulse.periods.d7.risers,[]);
  assert.deepEqual(pulse.periods.d7.decliners,[]);
});

test('raw personal Pulse never ranks a graded slab using raw FatePrice movement',()=>{
  const pulse=buildFateCollectorPersonalPulse({
    collectionItems:[
      {fateCardId:'card-a',quantity:1,status:'active',copyState:'graded'},
      {fateCardId:'card-b',quantity:1,status:'active',copyState:'raw'},
    ],
    cards:[cards[0],cards[1]],
    prices:[price('card-a',99,99),price('card-b',4,-8)],
  });
  assert.equal(pulse.ownedIdentityCount,1);
  assert.deepEqual(pulse.periods.d7.risers.map((row)=>row.cardIdentityId),['card-b']);
  assert.equal(pulse.periods.d7.risers.some((row)=>row.cardIdentityId==='card-a'),false);
});
