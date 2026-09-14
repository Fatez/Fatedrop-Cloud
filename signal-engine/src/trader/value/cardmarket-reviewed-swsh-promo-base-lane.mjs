// Frozen SWSH Black Star Promo evidence reviewed from production read-only audits:
// Phase 2 run 34811316030 (artifact 10334308761) and Phase 3 run 34811523955
// (artifact 10334388447), using pinned TCGdex revision
// 5b6a2859f454972477a9953ffe5cb554d24c45e9 and Cardmarket expansion 2916.
//
// These eight products map to verified English canonical holo identities. Their
// ordinary, unstamped identity is independently proven by explicit TCGdex
// variant evidence (Phase 2) or explicit variant candidates plus a unique
// attack/ability descriptor tie-break inside the already-proven set (Phase 3).
// Special/stamped/jumbo product ids remain isolated. Current Cardmarket price
// eligibility is rechecked separately: the base lane must be meaningful and the
// holo lane empty. This is not a wildcard promo or holo policy.
export const REVIEWED_SWSH_PROMO_BASE_LANE_REVISION = '5b6a2859f454972477a9953ffe5cb554d24c45e9';
export const REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID = 2916;

export const REVIEWED_SWSH_PROMO_BASE_LANE = Object.freeze([
  Object.freeze({ mappingId: 'fdcardmap_c072057650696cf714527b12', cardIdentityId: 'fdcard_8aa98c1575115ac0158ab35e', sourceRecordId: '576502', collectorNumber: 'swsh149', name: 'Flareon V', proof: 'phase2_explicit_unstamped_variant' }),
  Object.freeze({ mappingId: 'fdcardmap_86fd0939f258d5cd7fa5fc68', cardIdentityId: 'fdcard_b8bfa04ef76281d769ea172d', sourceRecordId: '576503', collectorNumber: 'swsh150', name: 'Vaporeon V', proof: 'phase2_explicit_unstamped_variant' }),
  Object.freeze({ mappingId: 'fdcardmap_fef29d35a22241c26ddd1c8c', cardIdentityId: 'fdcard_e097fe3f5ca8f843865e2abb', sourceRecordId: '576504', collectorNumber: 'swsh151', name: 'Jolteon V', proof: 'phase2_explicit_unstamped_variant' }),
  Object.freeze({ mappingId: 'fdcardmap_dbe6a09c1e92f893a732dd72', cardIdentityId: 'fdcard_d10ed9781b54f339acbfb4cc', sourceRecordId: '653693', collectorNumber: 'swsh225', name: 'Alolan Exeggutor V', proof: 'phase2_explicit_unstamped_variant' }),
  Object.freeze({ mappingId: 'fdcardmap_22bcd74942ab41bdb3784e7b', cardIdentityId: 'fdcard_fffef22ab570e8cef5fafe90', sourceRecordId: '576738', collectorNumber: 'swsh139', name: 'Pikachu V-UNION', proof: 'phase3_unique_descriptor_tiebreak' }),
  Object.freeze({ mappingId: 'fdcardmap_dbe0a5916ee513c85ab1fe6d', cardIdentityId: 'fdcard_717621254bbda0b9ec64f074', sourceRecordId: '572155', collectorNumber: 'swsh155', name: 'Greninja V-UNION', proof: 'phase3_unique_descriptor_tiebreak' }),
  Object.freeze({ mappingId: 'fdcardmap_e7f52433b1d5673a98175674', cardIdentityId: 'fdcard_f4cafa7e2bacf15ba571bc51', sourceRecordId: '572159', collectorNumber: 'swsh159', name: 'Mewtwo V-UNION', proof: 'phase3_unique_descriptor_tiebreak' }),
  Object.freeze({ mappingId: 'fdcardmap_d8c8fc4c8c19272d5731b348', cardIdentityId: 'fdcard_4cd3324ee8315a618847a522', sourceRecordId: '572163', collectorNumber: 'swsh163', name: 'Zacian V-UNION', proof: 'phase3_unique_descriptor_tiebreak' }),
]);

export const REVIEWED_SWSH_PROMO_BASE_LANE_PRODUCT_IDS = Object.freeze(
  REVIEWED_SWSH_PROMO_BASE_LANE.map((row) => row.sourceRecordId),
);

const byProductId = new Map(REVIEWED_SWSH_PROMO_BASE_LANE.map((row) => [row.sourceRecordId, row]));

export function isReviewedSwshPromoBaseLaneProduct(id) {
  return byProductId.has(String(id));
}

export function validateReviewedSwshPromoBaseLaneMappings(rows) {
  const scoped = (rows || []).filter((row) => (
    byProductId.has(String(row.source_record_id)) && row.source_variant_key === 'holo'
  ));
  if (scoped.length !== REVIEWED_SWSH_PROMO_BASE_LANE.length) return new Set();

  const valid = new Set();
  for (const row of scoped) {
    const expected = byProductId.get(String(row.source_record_id));
    if (!expected) return new Set();
    if (row.id !== expected.mappingId
      || row.card_identity_id !== expected.cardIdentityId
      || row.source_variant_key !== 'holo'
      || row.canonical_variant_code !== 'holo'
      || row.language_code !== 'en'
      || row.verification_status !== 'verified') return new Set();
    if (valid.has(expected.sourceRecordId)) return new Set();
    valid.add(expected.sourceRecordId);
  }
  return valid.size === REVIEWED_SWSH_PROMO_BASE_LANE.length ? valid : new Set();
}
