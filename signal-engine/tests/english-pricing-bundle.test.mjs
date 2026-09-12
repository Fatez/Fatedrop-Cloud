import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,checkpointValid,combineRecoveryProposals} from '../src/trader/value/english-pricing-bundle.mjs';
const identity=id=>({id,language_code:'en',verification_status:'verified',variant_code:'holo'});
const proposal=(cardIdentityId,sourceRecordId)=>({cardIdentityId,sourceRecordId,sourceVariantKey:'holo'});
function combine(reports,more={}){return combineRecoveryProposals({identities:[identity('a'),identity('b')],mappings:[],reports:reports.map((candidates,i)=>({stage:String(i),report:{candidates}})),...more});}
test('different stages agreeing produce one mapping with both methods',()=>{
 const r=combine([[proposal('a','10')],[proposal('a','10')]]);
 assert.equal(r.candidates.length,1);assert.deepEqual(r.candidates[0].methods,['0','1']);
});
test('cross-stage competing products hold every proposal regardless of order',()=>{
 for(const rows of [[proposal('a','10'),proposal('a','11')],[proposal('a','11'),proposal('a','10')]])assert.equal(combine(rows.map(r=>[r])).candidates.length,0);
});
test('cross-stage shared product holds both identities',()=>{
 assert.equal(combine([[proposal('a','10')],[proposal('b','10')]]).candidates.length,0);
});
test('unrelated clean candidate survives another conflict',()=>{
 const r=combine([[proposal('a','10'),proposal('b','20')],[proposal('a','11')]]);
 assert.deepEqual(r.candidates.map(c=>c.cardIdentityId),['b']);
});
test('existing ownership and existing canonical mappings cannot be overwritten',()=>{
 assert.equal(combine([[proposal('a','10')]],{mappings:[{card_identity_id:'other',source_record_id:'10',source_variant_key:'holo'}]}).candidates.length,0);
 assert.equal(combine([[proposal('a','10')]],{mappings:[{card_identity_id:'a',source_record_id:'11',source_variant_key:'holo'}]}).candidates.length,0);
});
test('language, verification and finish are enforced before accepting',()=>{
 for(const change of [{language_code:'ja'},{verification_status:'held'},{variant_code:'reverse-holo'}]){
 assert.equal(combine([[proposal('a','10')]],{identities:[{...identity('a'),...change}]}).candidates.length,0);
 }
 assert.equal(combine([[{...proposal('a','10'),sourceVariantKey:'normal'}]]).candidates.length,0);
});
test('additional exact evidence failure holds candidate',()=>{
 assert.equal(combine([[proposal('a','10')]],{validate:()=> 'collector_number_conflict'}).candidates.length,0);
});
test('checkpoint requires same code/source/database context and intact read-only output',()=>{
 const output={productionWrites:false,candidates:[]};const cp={context:'one',output,outputDigest:digest(output)};
 assert.equal(checkpointValid(cp,'one'),true);
 assert.equal(checkpointValid(cp,'two'),false);
 assert.equal(checkpointValid({...cp,output:{...output,candidates:['tampered']}},'one'),false);
 assert.equal(checkpointValid({...cp,output:undefined},'one'),false);
 assert.equal(checkpointValid({...cp,output:{productionWrites:true}},'one'),false);
});
