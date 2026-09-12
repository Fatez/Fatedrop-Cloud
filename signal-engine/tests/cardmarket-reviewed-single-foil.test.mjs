import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEWED_SINGLE_FOIL_PRODUCTS, validateReviewedSingleFoilMappings } from '../src/trader/value/cardmarket-reviewed-single-foil.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from '../src/trader/value/cardmarket-daily-ingest.mjs';
const rows = REVIEWED_SINGLE_FOIL_PRODUCTS.map(r => ({...r,source_name:'cardmarket',language_code:'en',verification_status:'verified'}));
test('203 exact reviewed products remain uniquely owned', () => {
 assert.equal(new Set(rows.map(r=>r.source_record_id)).size,203);
 assert.equal(validateReviewedSingleFoilMappings(rows).size,203);
});
test('ownership, variant, language and verification drift fail closed', () => {
 const original=rows[0];
 for (const change of [{id:'changed'},{card_identity_id:'changed'},{source_variant_key:'normal'},{canonical_variant_code:'reverse-holo'},{language_code:'ja'},{verification_status:'unverified'}]) {
  assert.equal(validateReviewedSingleFoilMappings([{...original,...change}]).size,0);
 }
 assert.equal(validateReviewedSingleFoilMappings([original,original]).size,0);
 assert.equal(validateReviewedSingleFoilMappings([original,{...original,id:'other',source_variant_key:'normal'}]).size,0);
});
test('reviewed foil base prices stay holo and conflicting ownership blocks fallback', async () => {
 const row=rows[0];
 const payload={version:1,createdAt:'2026-09-12T00:00:00Z',priceGuides:[{idProduct:Number(row.source_record_id),idCategory:51,trend:6.85,avg1:7.22,'trend-holo':0}]};
 const store={pool:async()=>({query:async()=>({rows:[row]})})};
 const batch=await prepareCardmarketDailyPriceGuideBatch({store,priceGuidePayload:payload,observedAt:Date.parse('2026-09-12T12:00:00Z')});
 assert.equal(batch.run.recordsAccepted,1);
 assert.equal(batch.observations[0].cardIdentityId,row.card_identity_id);
 assert.equal(batch.observations[0].sourceVariantKey,'holo');
 const conflict={pool:async()=>({query:async()=>({rows:[row,{...row,id:'other',card_identity_id:'other',source_variant_key:'normal'}]})})};
 const held=await prepareCardmarketDailyPriceGuideBatch({store:conflict,priceGuidePayload:payload,observedAt:Date.parse('2026-09-12T12:00:00Z')});
 assert.equal(held.observations.some(o=>o.cardIdentityId===row.card_identity_id),false);
});
