import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotHash, providerVariantKey, classifyVariant, buildResolutionLedger } from '../src/trader/value/variant-resolution-ledger.mjs';
const row = { cardIdentityId: 'a', variantCode: 'standard', language: 'en', edition: 'unspecified', externalFinishKeys: ['holofoil'] };
const raw = '{"explicitPrinting":"example reviewed source"}';
const hash = snapshotHash(raw);
const decision = { cardIdentityId:'a', finish:'standard', language:'en', edition:'unspecified', verdict:'exists', basis:'explicit_variant_record', reviewReference:'review/1', sourceLocator:'records/a', snapshotSha256:hash };
const price = { ...decision, exactMappingVerified:true, mappingReviewReference:'mapping/1', provider:'example', productId:'1', subtype:'normal', currency:'GBP', amount:2, observedAt:1000 };
const opts = { now:2000, snapshots:{[hash]:raw}, decisions:[decision], prices:[price] };
test('other finish keys and absent keys cannot prove existence or nonexistence', () => {
 for (const externalFinishKeys of [[], ['holofoil'], ['normal']]) assert.equal(classifyVariant({...row, externalFinishKeys}, {now:2000}).state,'UNRESOLVED_EVIDENCE');
});
test('existence and price are separate; zero/null/stale/wrong finish prices stay unpriced', () => {
 assert.equal(classifyVariant(row,opts).state,'ACTIVE_PRICED');
 for(const change of [{amount:0},{amount:null},{amount:'2'},{finish:'holo'},{language:'ja'},{edition:'first'},{observedAt:-900000000},{exactMappingVerified:false}])
   assert.equal(classifyVariant(row,{...opts,prices:[{...price,...change}]}).state,'ACTIVE_UNPRICED');
});
test('unreviewed or tampered source evidence cannot activate an identity', () => {
 assert.equal(classifyVariant(row,{...opts,snapshots:{[hash]:'changed'}}).state,'UNRESOLVED_EVIDENCE');
 assert.equal(classifyVariant(row,{...opts,decisions:[{...decision,reviewReference:''}]}).state,'UNRESOLVED_EVIDENCE');
 assert.equal(classifyVariant(row,{...opts,decisions:[{...decision,basis:'rarity'}]}).state,'UNRESOLVED_EVIDENCE');
});
test('explicit nonexistence is a review proposal, never deletion', () => {
 const result=classifyVariant(row,{...opts,decisions:[{...decision,verdict:'does_not_exist'}]});
 assert.equal(result.state,'INVALID_CATALOGUE_ENTRY');
 assert.equal(result.proposedAction,'dependency_review_required_no_deletion');
 assert.equal(result.productionWrites,false);
});
test('conflicting existence decisions remain unresolved', () => {
 assert.equal(classifyVariant(row,{...opts,decisions:[decision,{...decision,verdict:'does_not_exist'}]}).state,'UNRESOLVED_EVIDENCE');
});
test('conflicting current prices cannot select a first winner', () => {
 const result=classifyVariant(row,{...opts,prices:[price,{...price,amount:3}]});
 assert.equal(result.state,'ACTIVE_UNPRICED'); assert.equal(result.currentPrice,null);
});
test('compound source keys preserve finish and edition', () => {
 assert.notEqual(providerVariantKey('tcg','1','normal','en','unlimited'),providerVariantKey('tcg','1','holo','en','unlimited'));
});
test('ledger covers each identity once without counting unresolved as resolved', () => {
 const result=buildResolutionLedger([row],{now:2000});
 assert.equal(result.classified,1); assert.equal(result.resolved,0);
 assert.throws(()=>buildResolutionLedger([row,row],opts),/Duplicate/);
});
