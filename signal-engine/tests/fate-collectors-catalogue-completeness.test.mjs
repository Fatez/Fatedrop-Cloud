import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCanonicalSetCompleteness } from '../src/trader/catalogue/completeness.mjs';

const set = { id:'set1', total:3, printedTotal:2 };
const cards = [
  { id:'c1', setId:'set1', printingId:'p1', verificationStatus:'verified' },
  { id:'c1-rh', setId:'set1', printingId:'p1', verificationStatus:'verified' },
  { id:'c2', setId:'set1', printingId:'p2', verificationStatus:'verified' },
  { id:'other', setId:'set2', printingId:'p9', verificationStatus:'verified' },
  { id:'staged', setId:'set1', printingId:'p3', verificationStatus:'staged' },
];

test('variant identities do not inflate observed canonical printing count', () => {
  const result = assessCanonicalSetCompleteness({ set, canonicalCards:cards });
  assert.equal(result.status,'incomplete');
  assert.equal(result.expectedTotal,3);
  assert.equal(result.observedTotal,2);
  assert.equal(result.missingCanonicalCount,1);
});

test('complete requires exact verified printing count when exact total is declared', () => {
  const result = assessCanonicalSetCompleteness({
    set,
    canonicalCards:[...cards,{id:'c3',setId:'set1',printingId:'p3',verificationStatus:'verified'}],
  });
  assert.equal(result.status,'complete');
  assert.equal(result.observedTotal,3);
});

test('exceeding exact declared total is a conflict rather than silently complete', () => {
  const result = assessCanonicalSetCompleteness({
    set,
    canonicalCards:[...cards,
      {id:'c3',setId:'set1',printingId:'p3',verificationStatus:'verified'},
      {id:'c4',setId:'set1',printingId:'p4',verificationStatus:'verified'},
    ],
  });
  assert.equal(result.status,'conflict');
});

test('printed total is a floor when exact total is unavailable so secret cards do not create false conflicts', () => {
  const result = assessCanonicalSetCompleteness({
    set:{id:'set1',total:null,printedTotal:2},
    canonicalPrintings:[
      {id:'p1',setId:'set1',verificationStatus:'verified'},
      {id:'p2',setId:'set1',verificationStatus:'verified'},
      {id:'p3',setId:'set1',verificationStatus:'verified'},
    ],
  });
  assert.equal(result.status,'complete');
  assert.equal(result.expectedTotal,3);
  assert.equal(result.observedTotal,3);
  assert.equal(result.missingCanonicalCount,0);
});

test('printed-total floor still fails closed when the numbered checklist itself is incomplete', () => {
  const result = assessCanonicalSetCompleteness({
    set:{id:'set1',total:null,printedTotal:3},
    canonicalPrintings:[
      {id:'p1',setId:'set1',verificationStatus:'verified'},
      {id:'p2',setId:'set1',verificationStatus:'verified'},
    ],
  });
  assert.equal(result.status,'incomplete');
  assert.equal(result.expectedTotal,3);
  assert.equal(result.observedTotal,2);
  assert.equal(result.missingCanonicalCount,1);
});

test('zero exact total falls back to the printed-total floor', () => {
  const result = assessCanonicalSetCompleteness({
    set:{id:'set1',total:0,printedTotal:2},
    canonicalPrintings:[
      {id:'p1',setId:'set1',verificationStatus:'verified'},
      {id:'p2',setId:'set1',verificationStatus:'verified'},
    ],
  });
  assert.equal(result.status,'complete');
  assert.equal(result.expectedTotal,2);
});

test('missing declared total stays unknown and fails closed', () => {
  const result = assessCanonicalSetCompleteness({ set:{id:'set1'}, canonicalCards:cards });
  assert.equal(result.status,'unknown');
  assert.equal(result.expectedTotal,null);
});
