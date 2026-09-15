import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEWED_SV_PROFESSOR_ADDENDUM,
  REVIEWED_SV_PROFESSOR_ADDENDUM_PRODUCT_IDS,
  isReviewedSvProfessorAddendumProduct,
  validateReviewedSvProfessorAddendumMappings,
} from '../src/trader/value/cardmarket-reviewed-sv-professor-addendum.mjs';
import { collectCurrentGuideInherentHoloBaseLaneEligibleProductIds } from '../src/trader/value/cardmarket-daily-ingest.mjs';

test('SVI Professor addendum is exactly the two reviewed holo mappings', () => {
  assert.deepEqual(REVIEWED_SV_PROFESSOR_ADDENDUM_PRODUCT_IDS, ['689768', '689769']);
  assert.equal(REVIEWED_SV_PROFESSOR_ADDENDUM.length, 2);
  assert.equal(isReviewedSvProfessorAddendumProduct('689768'), true);
  assert.equal(isReviewedSvProfessorAddendumProduct('689769'), true);
  assert.equal(isReviewedSvProfessorAddendumProduct('702536'), false);

  const rows = REVIEWED_SV_PROFESSOR_ADDENDUM.map((row) => ({
    id: row.mappingId,
    card_identity_id: row.cardIdentityId,
    source_record_id: row.sourceRecordId,
    source_variant_key: 'holo',
    canonical_variant_code: 'holo',
    language_code: 'en',
    verification_status: 'verified',
  }));
  assert.deepEqual([...validateReviewedSvProfessorAddendumMappings(rows)].sort(), ['689768', '689769']);
});

test('current Cardmarket base lane is eligible only when no positive holo lane exists', () => {
  const eligible = collectCurrentGuideInherentHoloBaseLaneEligibleProductIds({
    priceGuides: [
      { idProduct: 689768, trend: 1.2, avg1: 1.3, trendHolo: null, avg1Holo: null },
      { idProduct: 689769, trend: 1.4, avg1: 1.5, trendHolo: 2.0, avg1Holo: null },
    ],
  });
  assert.equal(eligible.has('689768'), true);
  assert.equal(eligible.has('689769'), false);
});
