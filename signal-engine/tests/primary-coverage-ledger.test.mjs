import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimaryCoverageLedger as build } from '../src/trader/catalogue/primary-coverage-ledger.mjs';
const card = (id, extra={})=>({id,setId:'set',language:'en',englishNamed:true,explicitFinishes:['normal','reverse'],...extra});
const census = cards=>({format:'fatedrop-primary-source-census-v1',revision:'pinned',cards});
const mapping = (id,variantCode='standard',extra={})=>({sourceName:'tcgdex',sourceRecordId:id,cardIdentityId:`${id}-${variantCode}`,canonicalKey:`key-${id}-${variantCode}`,variantCode,languageCode:'en',...extra});
test('mapping counts never substitute for unique cards or full finish coverage',()=>{
 const r=build(census([card('one'),card('two'),card('three',{explicitFinishes:[]})]),[mapping('one'),mapping('one'),mapping('three')]);
 assert.equal(r.counts.partially_mapped,1);assert.equal(r.counts.not_mapped,1);assert.equal(r.counts.mapped_finish_scope_unresolved,1);assert.equal(r.sourceRecords,3);assert.equal(r.canonicalIdentitiesInMappingExport,2);assert.equal(r.productionCoverage,null);
});
test('wrong languages do not satisfy English and quarantines remain held',()=>{
 const r=build(census([card('one'),card('two',{held:true}),card('digital',{digital:true})]),[mapping('one','standard',{languageCode:'fr'})]);
 assert.equal(r.counts.not_mapped,1);assert.equal(r.counts.intentional_hold,1);assert.equal(r.counts.outside_physical_scope,1);
});
test('duplicates fail and replay remains deterministic',()=>{
 assert.throws(()=>build(census([card('one'),card('one')]),[]),/Duplicate/);
 assert.throws(()=>build(census([card('one')]),[mapping('one'),mapping('one','standard',{cardIdentityId:'other'})]),/Duplicate canonical/);
 const c=census([card('one')]);const m=[mapping('one'),mapping('one','reverse-holo')];
 assert.deepEqual(build(c,m),build(c,m));assert.equal(build(c,m).counts.explicit_finishes_mapped,1);assert.equal(build(c,m).completeCanonicalCardinality,null);
});
