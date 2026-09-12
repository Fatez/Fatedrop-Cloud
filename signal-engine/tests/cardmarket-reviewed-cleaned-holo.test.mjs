import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReviewedCleanedHoloMappings} from '../src/trader/value/cardmarket-reviewed-cleaned-holo.mjs';
import {prepareCardmarketDailyPriceGuideBatch} from '../src/trader/value/cardmarket-daily-ingest.mjs';
const rows=[
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_adec52f6cb12339d56c7e555",
    "id": "fdcardmap_4d40891ab0d41c089a36a47f",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "567125",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_1c6efeb2c0dc8e0096905d5f",
    "id": "fdcardmap_242b0fde4230858e65f340ae",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "567126",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_633b51df822f89699654d2d3",
    "id": "fdcardmap_87ce7a4511d0d3dae539880a",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "574064",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_65468b4eaa68ca7cd442fa96",
    "id": "fdcardmap_ed5b2e771cace89860e3fe08",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "574065",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_9ea8ff18394a616370d3691f",
    "id": "fdcardmap_09b2aed995afba0cb3364a6d",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "658696",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_04f06ffda69f2fbdd0570abf",
    "id": "fdcardmap_b1d049cda7c15cb85714bf98",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "665266",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_f519a07734a521968740cd2e",
    "id": "fdcardmap_9baa3344cd19a99c46afcde5",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "682075",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_a4afad4b2f09622b9c5a4059",
    "id": "fdcardmap_8c88e0047498f011c58bd5fa",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "725122",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_08129fdd659788430c6d91f5",
    "id": "fdcardmap_5c0af387dfb8025f7f5ef94d",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "725244",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_bb8f7906e50df27661fdb291",
    "id": "fdcardmap_b0f12e2a1b7c3db9cea2d3b2",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "740733",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_58856a0edf60e8510b5f2a16",
    "id": "fdcardmap_309c4251e135dbcc5be5faee",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "760642",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_3e1d51147ac93d1bf8b02ec8",
    "id": "fdcardmap_973e5d4a1e4920bb6d70d8be",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "769214",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_69966eff1b5e26e1e7936880",
    "id": "fdcardmap_06341c2ee9abe8dbdf0cc72a",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "769238",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_857e5843eaab4396ae87409a",
    "id": "fdcardmap_d430b7f0b020ba5c2c542a5c",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "769308",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_081adb202d555b879a41c238",
    "id": "fdcardmap_0ccd53bcd1749eec6f8bc81c",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "780902",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_36d48b34cedb68a115d8366e",
    "id": "fdcardmap_07e12b83ef980b947054944c",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "785852",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_3c7411d7b0fe2625131e1979",
    "id": "fdcardmap_ed13f1d5bf274431d9bbb24f",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "785883",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_399682c17f0ba04af04f02bb",
    "id": "fdcardmap_b0e2c6868f0952e6281f5219",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "785895",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_e0e75e6b16c7830ae86802ad",
    "id": "fdcardmap_036bf5090f7982ccd22fc9ee",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "785959",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_7d736f1b800dd049ae69ec7b",
    "id": "fdcardmap_a8023347130658c8da4dfb0d",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "786003",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_63e203ec9ce37cc3821eb09f",
    "id": "fdcardmap_026b34444a7b1f9755be76a8",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "794314",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_fe0a12e079698c49ae4c9a88",
    "id": "fdcardmap_5f668865ece54d5fc9ad81e0",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "794373",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_e875e0ea08101293778a7794",
    "id": "fdcardmap_e1be321a93da6f9312ed860a",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "794503",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_2c9d7be25f8a66511047e2f0",
    "id": "fdcardmap_469afb26c0c261995b68ee8a",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805395",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_710aef2d9f251834c0eee131",
    "id": "fdcardmap_2d4b25b50634c985b5fb0bc2",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805403",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_c5b29d3e3055d592e4aebf49",
    "id": "fdcardmap_3b2fdf9647c3b354b832bf59",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805412",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_92420f58aa5bf485f7ac58cf",
    "id": "fdcardmap_add17a3f05b362bf3bdfc0ab",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805415",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_cdcc882abeeea37cad0f3789",
    "id": "fdcardmap_04f0ac50687e77f8038fccc2",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805419",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_5410c930dd8c5dff6eaadeb2",
    "id": "fdcardmap_fc8b900b86118fb23064edaf",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805423",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_771a0e38305d6f9c65396803",
    "id": "fdcardmap_d078347710c31c8a656014de",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805430",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_eb1d458388a7feca11175fe6",
    "id": "fdcardmap_3ea51dfefdc64414fa964f86",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805449",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_48b15cd932187842ffacca61",
    "id": "fdcardmap_e49628a114fe0dc5fb5e6bf3",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805453",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_1ff7e011f27b4585cd3d70f8",
    "id": "fdcardmap_ff7c166411fd327bc9942f3c",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805465",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_a5056ebf73833f6c54a22881",
    "id": "fdcardmap_0dee1b2264190372d5933fa3",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "805474",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_b51d636a055cfce85ce9ecfd",
    "id": "fdcardmap_7274a931a562335f95a4da60",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "817176",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_c01ccab5a1608b900ffdde87",
    "id": "fdcardmap_3d1dfba0b82867423094edea",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "817182",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_62a6fe4a92d39f0179208524",
    "id": "fdcardmap_4fee8019629226c190c5bbff",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "817221",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_54443ed9fdc7963d14e0368c",
    "id": "fdcardmap_b0c9502b77b86d830d1a4541",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "817266",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_c70d4d40bf831e0dde439ca2",
    "id": "fdcardmap_4979870a745de225b9a4b893",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "817320",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_cedf87a4f759d8c4a2d29201",
    "id": "fdcardmap_7cd0890511225168b6431be6",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "851204",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_edae92e65e2d789a7f002d1f",
    "id": "fdcardmap_d2836aa7493a441005caff57",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "869697",
    "source_variant_key": "holo",
    "verification_status": "verified"
  },
  {
    "canonical_variant_code": "holo",
    "card_identity_id": "fdcard_722d99ddbaaa8c4ff508fcaa",
    "id": "fdcardmap_c4b896fcccfb8ffb3e50357b",
    "language_code": "en",
    "source_name": "cardmarket",
    "source_record_id": "869766",
    "source_variant_key": "holo",
    "verification_status": "verified"
  }
];
test('post-correction 42-card ownership matches frozen evidence and rejects drift',()=>{
 assert.equal(validateReviewedCleanedHoloMappings(rows).size,42);
 assert.equal(validateReviewedCleanedHoloMappings(rows.slice(1)).size,0);
 assert.equal(validateReviewedCleanedHoloMappings([...rows,rows[0]]).size,0);
 for(const change of [{id:'wrong'},{card_identity_id:'wrong'},{language_code:'ja'},{canonical_variant_code:'reverse-holo'}]){
 assert.equal(validateReviewedCleanedHoloMappings([{...rows[0],...change},...rows.slice(1)]).size,0);
 }
 assert.equal(validateReviewedCleanedHoloMappings([...rows,{...rows[0],source_variant_key:'normal'}]).size,41);
});
test('all 42 retain holo identity, replay identically, and normal competition blocks substitution',async()=>{
 const input={version:1,createdAt:'2026-09-12T00:00:00Z',priceGuides:rows.map(r=>({idProduct:Number(r.source_record_id),idCategory:51,trend:2,avg7:2,'trend-holo':0}))};
 const options={store:{pool:async()=>({query:async()=>({rows})})},priceGuidePayload:input,observedAt:Date.parse('2026-09-12T12:00:00Z')};
 const a=await prepareCardmarketDailyPriceGuideBatch(options),b=await prepareCardmarketDailyPriceGuideBatch(options);
 assert.equal(a.observations.length,42);
 assert.equal(new Set(a.observations.map(o=>o.cardIdentityId)).size,42);
 assert(a.observations.every(o=>o.sourceVariantKey==='holo'));
 assert.deepEqual(a.observations,b.observations);
 const changed=[...rows,{...rows[0],id:'normal-owner',card_identity_id:'normal-card',source_variant_key:'normal',canonical_variant_code:'standard'}];
 const c=await prepareCardmarketDailyPriceGuideBatch({...options,store:{pool:async()=>({query:async()=>({rows:changed})})}});
 assert.equal(c.observations.filter(o=>o.sourceVariantKey==='holo').length,41);
 assert(!c.observations.some(o=>o.cardIdentityId===rows[0].card_identity_id));
});
