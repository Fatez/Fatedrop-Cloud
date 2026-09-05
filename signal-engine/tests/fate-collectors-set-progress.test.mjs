import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCollectionSetProgress } from '../src/trader/collection/set-progress.mjs';

function card({
  tcgCode,
  setId,
  printingId,
  id,
  number,
  name,
  variantCode = 'standard',
  languageCode = 'en',
  verificationStatus = 'verified',
}) {
  return {
    id,
    fateCardId: id,
    tcgCode,
    setId,
    setName: 'Test Set',
    printingId,
    collectorNumber: String(number),
    name,
    variantCode,
    languageCode,
    verificationStatus,
  };
}

test('Pokemon completion collapses finish variants to one canonical printing slot', () => {
  const cards = [
    card({ tcgCode:'pokemon',setId:'sv-test',printingId:'p1',id:'p1-standard',number:1,name:'Bulbasaur' }),
    card({ tcgCode:'pokemon',setId:'sv-test',printingId:'p1',id:'p1-reverse',number:1,name:'Bulbasaur',variantCode:'reverse-holo' }),
    card({ tcgCode:'pokemon',setId:'sv-test',printingId:'p2',id:'p2-standard',number:2,name:'Ivysaur' }),
    card({ tcgCode:'pokemon',setId:'sv-test',printingId:'p3',id:'p3-standard',number:3,name:'Venusaur' }),
  ];
  const result = computeCollectionSetProgress({
    set:{ id:'sv-test',name:'Test Set',tcgCode:'pokemon' },
    canonicalCards:cards,
    collectionItems:[{ fateCardId:'p1-reverse',quantity:1 }],
  });
  assert.equal(result.totalCount,3);
  assert.equal(result.ownedCount,1);
  assert.equal(result.missingCount,2);
  assert.equal(result.completionPercent,33.3);
  assert.deepEqual(result.missingCards.map((entry) => entry.collectorNumber),['2','3']);
});

test('One Piece uses the same engine and keeps distinct canonical printings distinct', () => {
  const cards = [
    card({ tcgCode:'one-piece',setId:'op-test',printingId:'op1',id:'op1-standard',number:'001',name:'Leader' }),
    card({ tcgCode:'one-piece',setId:'op-test',printingId:'op1-parallel',id:'op1-parallel',number:'001',name:'Leader Parallel',variantCode:'parallel' }),
    card({ tcgCode:'one-piece',setId:'op-test',printingId:'op2',id:'op2-standard',number:'002',name:'Character' }),
  ];
  const result = computeCollectionSetProgress({
    set:{ id:'op-test',name:'OP Test',tcgCode:'one-piece' },
    canonicalCards:cards,
    collectionItems:[{ fateCardId:'op1-standard',quantity:1 },{ fateCardId:'op2-standard',quantity:1 }],
  });
  assert.equal(result.totalCount,3);
  assert.equal(result.ownedCount,2);
  assert.equal(result.missingCount,1);
  assert.equal(result.missingCards[0].fateCardId,'op1-parallel');
});

test('Lorcana uses the same calculation without game-specific branches', () => {
  const cards = [
    card({ tcgCode:'lorcana',setId:'lor-test',printingId:'l1',id:'l1',number:1,name:'Mickey' }),
    card({ tcgCode:'lorcana',setId:'lor-test',printingId:'l2',id:'l2',number:2,name:'Minnie' }),
  ];
  const result = computeCollectionSetProgress({
    set:{ id:'lor-test',name:'Lorcana Test',tcgCode:'lorcana' },
    canonicalCards:cards,
    collectionItems:[{ fateCardId:'l2',quantity:2 }],
  });
  assert.equal(result.totalCount,2);
  assert.equal(result.ownedCount,1);
  assert.equal(result.missingCount,1);
  assert.equal(result.missingCards[0].name,'Mickey');
});

test('missing-card output ignores removed items, other sets and unverified catalogue identities', () => {
  const cards = [
    card({ tcgCode:'pokemon',setId:'set-a',printingId:'a1',id:'a1',number:1,name:'One' }),
    card({ tcgCode:'pokemon',setId:'set-a',printingId:'a2',id:'a2',number:2,name:'Two' }),
    card({ tcgCode:'pokemon',setId:'set-a',printingId:'a3',id:'a3',number:3,name:'Three',verificationStatus:'staged' }),
    card({ tcgCode:'pokemon',setId:'set-b',printingId:'b1',id:'b1',number:1,name:'Other' }),
  ];
  const result = computeCollectionSetProgress({
    set:{ id:'set-a',name:'A',tcgCode:'pokemon' },
    canonicalCards:cards,
    collectionItems:[{ fateCardId:'a1',quantity:1,status:'removed' },{ fateCardId:'b1',quantity:1 }],
  });
  assert.equal(result.totalCount,2);
  assert.equal(result.ownedCount,0);
  assert.deepEqual(result.missingCards.map((entry) => entry.fateCardId),['a1','a2']);
});

test('graded pride cards never fill a raw binder slot', () => {
  const cards = [
    card({ tcgCode:'pokemon',setId:'set-a',printingId:'a1',id:'a1',number:1,name:'One' }),
    card({ tcgCode:'pokemon',setId:'set-a',printingId:'a2',id:'a2',number:2,name:'Two' }),
  ];
  const result = computeCollectionSetProgress({
    set:{ id:'set-a',name:'A',tcgCode:'pokemon' },
    canonicalCards:cards,
    collectionItems:[
      { fateCardId:'a1',quantity:1,status:'active',copyState:'graded',grading:{gradingCompany:'PSA',gradeLabel:'10'} },
      { fateCardId:'a2',quantity:1,status:'active',copyState:'raw' },
    ],
  });
  assert.equal(result.ownedCount,1);
  assert.equal(result.missingCount,1);
  assert.deepEqual(result.missingCards.map((entry) => entry.fateCardId),['a1']);
});

test('fails closed when there is no verified canonical checklist', () => {
  const result = computeCollectionSetProgress({
    set:{ id:'empty',name:'Empty',tcgCode:'lorcana' },
    canonicalCards:[],
    collectionItems:[],
  });
  assert.equal(result.status,'unavailable');
  assert.equal(result.reason,'canonical_set_checklist_unavailable');
  assert.equal(result.completionPercent,null);
  assert.deepEqual(result.missingCards,[]);
});
