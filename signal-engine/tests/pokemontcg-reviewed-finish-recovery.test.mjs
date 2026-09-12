import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadReviewedPokemonTcgFinishRecovery,
  loadReviewedUmbreonSiblingRecovery,
  loadReviewedCombinedCardmarketRecovery,
  REVIEWED_POKEMONTCG_INHERENT_HOLO_PRODUCT_IDS,
  validateReviewedPokemonTcgInherentHoloMappings,
} from '../src/trader/value/pokemontcg-reviewed-finish-recovery.mjs';
import {
  collectCurrentGuideInherentHoloBaseLaneEligibleProductIds,
} from '../src/trader/value/cardmarket-daily-ingest.mjs';
import { normaliseReviewedCollectorNumber } from '../src/trader/value/pokemontcg-reviewed-finish-recovery-cli.mjs';

const snorlax = {
  id: 'fdcardmap_15c449fc9d730a4afc896c79',
  card_identity_id: 'fdcard_78c6a757bf7adae4bf112304',
  source_name: 'cardmarket',
  source_record_id: '687429',
  source_variant_key: 'holo',
  canonical_variant_code: 'holo',
  language_code: 'en',
  verification_status: 'verified',
};

test('loads the exact frozen 410-card external finish cohort', () => {
  const { candidates } = loadReviewedPokemonTcgFinishRecovery();
  assert.equal(candidates.length, 410);
  assert.equal(candidates.filter((row) => row.variantCode === 'standard').length, 359);
  assert.equal(candidates.filter((row) => row.variantCode === 'holo').length, 51);
  assert.equal(candidates.filter((row) => row.proof.cardmarketLaneBasis === 'direct_cardmarket_finish_lane').length, 409);
  assert.equal(candidates.filter((row) => row.proof.cardmarketLaneBasis === 'externally_proven_inherent_holo_base_lane').length, 1);
  assert.equal(new Set(candidates.map((row) => row.cardIdentityId)).size, 410);
  assert.equal(new Set(candidates.map((row) => `${row.sourceRecordId}|${row.sourceVariantKey}`)).size, 410);
  for (const row of candidates) {
    assert.equal(row.sourceVariantKey, row.variantCode === 'standard' ? 'normal' : 'holo');
    assert.equal(row.proof.externalFinishKey, row.variantCode === 'standard' ? 'normal' : 'holofoil');
  }
});

test('loads the exact saved Umbreon sibling mapping and combines without collision', () => {
  const { candidate } = loadReviewedUmbreonSiblingRecovery();
  assert.equal(candidate.cardIdentityId, 'fdcard_043a2f0fc48bc2f9afaf7be5');
  assert.equal(candidate.name, 'Umbreon');
  assert.equal(candidate.collectorNumber, 'swsh129');
  assert.equal(candidate.tcgdexCardId, 'swshp-SWSH129');
  assert.equal(String(candidate.sourceRecordId), '568801');
  assert.equal(candidate.sourceVariantKey, 'normal');
  assert.equal(candidate.providerPriceGuideLane, 'standard');
  assert.equal(candidate.proof.siblingEvidence[0].cardIdentityId, 'fdcard_3c5841311477627da2c18e7d');

  const combined = loadReviewedCombinedCardmarketRecovery().candidates;
  assert.equal(combined.length, 411);
  assert.equal(combined.filter((row) => row.variantCode === 'standard').length, 360);
  assert.equal(combined.filter((row) => row.variantCode === 'holo').length, 51);
  assert.equal(new Set(combined.map((row) => row.cardIdentityId)).size, 411);
  assert.equal(new Set(combined.map((row) => `${row.sourceRecordId}|${row.sourceVariantKey}`)).size, 411);
});

test('the only reviewed base-lane holo is Snorlax VMAX 687429', () => {
  const { candidates } = loadReviewedPokemonTcgFinishRecovery();
  const exceptional = candidates.filter((row) => row.proof.cardmarketLaneBasis === 'externally_proven_inherent_holo_base_lane');
  assert.deepEqual(REVIEWED_POKEMONTCG_INHERENT_HOLO_PRODUCT_IDS, ['687429']);
  assert.equal(exceptional.length, 1);
  assert.equal(String(exceptional[0].sourceRecordId), '687429');
  assert.equal(exceptional[0].variantCode, 'holo');
  assert.equal(exceptional[0].providerPriceGuideLane, 'standard');
  assert.ok(exceptional[0].proof.externalFinishKeys.includes('holofoil'));
  assert.ok(!exceptional[0].proof.externalFinishKeys.includes('normal'));
});

test('Snorlax mapping integrity accepts only the frozen verified English holo owner', () => {
  assert.deepEqual([...validateReviewedPokemonTcgInherentHoloMappings([snorlax])], ['687429']);
  assert.equal(validateReviewedPokemonTcgInherentHoloMappings([{ ...snorlax, language_code: 'ja' }]).size, 0);
  assert.equal(validateReviewedPokemonTcgInherentHoloMappings([{ ...snorlax, canonical_variant_code: 'standard' }]).size, 0);
  assert.equal(validateReviewedPokemonTcgInherentHoloMappings([{ ...snorlax, source_variant_key: 'normal' }]).size, 0);
});

test('Cardmarket guide eligibility recognizes reviewed Snorlax only with base price and no holo lane', () => {
  const eligible = collectCurrentGuideInherentHoloBaseLaneEligibleProductIds({
    priceGuides: [{ idProduct: 687429, trend: 10.5, avg1: 10.4, avg7: 10.3, avg30: 10.2 }],
  });
  assert.ok(eligible.has('687429'));

  const explicitHolo = collectCurrentGuideInherentHoloBaseLaneEligibleProductIds({
    priceGuides: [{ idProduct: 687429, trend: 10.5, 'trend-holo': 12.5 }],
  });
  assert.ok(!explicitHolo.has('687429'));
});

test('collector normalization preserves semantic suffixes', () => {
  assert.equal(normaliseReviewedCollectorNumber(' 067 '), '67');
  assert.equal(normaliseReviewedCollectorNumber('SWSH178'), 'SWSH178');
  assert.equal(normaliseReviewedCollectorNumber('GG026'), 'GG26');
});
