import assert from 'node:assert/strict';
import test from 'node:test';

import { assessCanonicalSetCompleteness } from '../src/trader/catalogue/completeness.mjs';

const set={id:'pokemon:sv-demo',printedTotal:2,total:2};

function card(id,printingId,collectorNumber,languageCode='en',variantCode='standard'){
  return{id,fateCardId:id,setId:set.id,printingId,collectorNumber,languageCode,variantCode,verificationStatus:'verified'};
}

test('collector-ready counts printings while allowing multiple explicit variants',()=>{
  const result=assessCanonicalSetCompleteness({
    set,
    canonicalCards:[
      card('c1','p1','1','en','standard'),
      card('c1r','p1','1','en','reverse-holo'),
      card('c2','p2','2','en','holo'),
    ],
    requiredLanguageCode:'en',
  });
  assert.equal(result.status,'complete');
  assert.equal(result.observedTotal,2);
  assert.equal(result.verifiedIdentityCount,3);
});

test('missing canonical language or variant dimensions blocks collector readiness',()=>{
  const missingVariant=assessCanonicalSetCompleteness({
    set,
    canonicalCards:[card('c1','p1','1'),{...card('c2','p2','2'),variantCode:''}],
    requiredLanguageCode:'en',
  });
  assert.equal(missingVariant.status,'incomplete');
  assert.equal(missingVariant.reason,'canonical_identity_dimensions_incomplete');
  assert.equal(missingVariant.identityDimensionGaps.variantCode,1);
});

test('required English checklist must cover every verified printing',()=>{
  const result=assessCanonicalSetCompleteness({
    set,
    canonicalCards:[card('c1','p1','1','en'),card('c2','p2','2','ja')],
    requiredLanguageCode:'en',
  });
  assert.equal(result.status,'incomplete');
  assert.equal(result.reason,'required_language_checklist_incomplete');
  assert.equal(result.missingRequiredLanguagePrintings,1);
});

test('duplicate exact printing-language-variant identities fail as a conflict',()=>{
  const result=assessCanonicalSetCompleteness({
    set:{...set,total:1,printedTotal:1},
    canonicalCards:[card('c1','p1','1'),card('c1-duplicate','p1','1')],
    requiredLanguageCode:'en',
  });
  assert.equal(result.status,'conflict');
  assert.equal(result.reason,'canonical_identity_dimension_duplicate');
});
