import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEWED_GALLERY_HOLO, validateReviewedGalleryHolo } from '../src/trader/value/cardmarket-reviewed-gallery-holo.mjs';
import { collectCurrentGuideInherentHoloBaseLaneEligibleProductIds } from '../src/trader/value/cardmarket-daily-ingest.mjs';
const row = e=>({...e,source_variant_key:'holo',canonical_variant_code:'holo',language_code:'en',verification_status:'verified'});
test('all 136 exact frozen owners validate',()=>{assert.equal(new Set(REVIEWED_GALLERY_HOLO.map(r=>r.source_record_id)).size,136); assert.equal(validateReviewedGalleryHolo(REVIEWED_GALLERY_HOLO.map(row)).size,136);});
test('changed ownership, finish or language fails closed',()=>{for(const patch of [{id:'different'},{card_identity_id:'different'},{language_code:'ja'},{canonical_variant_code:'standard'},{source_variant_key:'normal'}]) assert.equal(validateReviewedGalleryHolo([{...row(REVIEWED_GALLERY_HOLO[0]),...patch}]).size,0);});
test('competing normal or second holo owner blocks the product',()=>{const a=row(REVIEWED_GALLERY_HOLO[0]); for(const finish of ['normal','holo']) assert.equal(validateReviewedGalleryHolo([a,{...a,id:'other',source_variant_key:finish}]).size,0);});
test('provider holo field takes priority and unknown products stay excluded',()=>{const id=REVIEWED_GALLERY_HOLO[0].source_record_id; assert.equal(collectCurrentGuideInherentHoloBaseLaneEligibleProductIds({priceGuides:[{idProduct:id,trend:1}]}).has(id),true);assert.equal(collectCurrentGuideInherentHoloBaseLaneEligibleProductIds({priceGuides:[{idProduct:id,trend:1,'trend-holo':2},{idProduct:'999999999',trend:3}]}).size,0);});
