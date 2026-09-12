import { createHash } from 'node:crypto';

// Frozen exact evidence class reviewed 2026-09-12 from production residual audit run 34707568854.
// TCGdex evidence revision: 5b6a2859f454972477a9953ffe5cb554d24c45e9.
// Every product below belongs to a verified English canonical holo identity with one TCGdex card link,
// exactly one holo variant on that card, no stamp, and an explicit Cardmarket product ID equal to the
// existing exact holo mapping. Current-guide eligibility is still checked separately: base lane must
// be meaningful and Cardmarket's holo lane must be empty. No wildcard foil or stamped policy exists.
// This cohort is separate from the 2,051 inherent-holo policy and the 213 reviewed single-foil policy.
export const REVIEWED_EXPLICIT_HOLO_BASE_LANE_REVISION = '5b6a2859f454972477a9953ffe5cb554d24c45e9';
export const REVIEWED_EXPLICIT_HOLO_BASE_LANE_PRODUCT_IDS = Object.freeze(`547881,547886,547931,547936,562455,562456,568801,583199,583200,583201,583202,606748,606749,609463,609464,653698,659061,659062,659063,659064,659583,664337,664338,664339,665677,665987,665988,665989,665990,669496,682974,682975,682976,684385,684386,684387,684388,716228,725102,725146,727116,727117,760792,766664,766665,775950,775951,781855,781856,781858,781860,784939,784940,786028,786047,786048,786049,786050,789503,789504,791826,791827,791828,800145,800146,800147,800149,819346,819348,833339,833342,836667,836668,836669,857705,858714,858715,858718,858719,862193,862194,862195,870106,870107,870110,878074,878075,878076,878475,884285,884286`.split(','));
export const REVIEWED_EXPLICIT_HOLO_BASE_LANE_MAPPING_DIGEST = '1f3c4d91e9c29b0eb3f497cef20bcb5ac0de0478f57aa3d7976bab4b51fc078b';

const productIds = new Set(REVIEWED_EXPLICIT_HOLO_BASE_LANE_PRODUCT_IDS);
export function isReviewedExplicitHoloBaseLaneProduct(id) {
  return productIds.has(String(id));
}

function mappingLine(row) {
  return [
    row.id,
    row.card_identity_id,
    String(row.source_record_id),
    row.source_variant_key,
    row.canonical_variant_code,
    row.language_code,
    row.verification_status,
  ].join('|');
}

export function validateReviewedExplicitHoloBaseLaneMappings(rows) {
  // The frozen digest proves the 91 exact holo mappings themselves. A product
  // may also acquire a separate normal mapping later; that competing owner is
  // still blocked per product by cardmarket-daily-ingest's !normal safeguard.
  // Do not let such a normal row invalidate unrelated, unchanged holo proofs.
  const scoped = (rows || []).filter((row) => (
    productIds.has(String(row.source_record_id))
    && row.source_variant_key === 'holo'
  ));
  if (scoped.length !== REVIEWED_EXPLICIT_HOLO_BASE_LANE_PRODUCT_IDS.length) return new Set();
  const seen = new Set(scoped.map((row) => String(row.source_record_id)));
  if (seen.size !== REVIEWED_EXPLICIT_HOLO_BASE_LANE_PRODUCT_IDS.length) return new Set();
  if (scoped.some((row) => row.source_variant_key !== 'holo'
    || row.canonical_variant_code !== 'holo'
    || row.language_code !== 'en'
    || row.verification_status !== 'verified')) return new Set();
  const canonical = [...scoped]
    .sort((left, right) => String(left.source_record_id).localeCompare(String(right.source_record_id)))
    .map(mappingLine)
    .join('\n');
  const digest = createHash('sha256').update(canonical).digest('hex');
  return digest === REVIEWED_EXPLICIT_HOLO_BASE_LANE_MAPPING_DIGEST
    ? new Set(REVIEWED_EXPLICIT_HOLO_BASE_LANE_PRODUCT_IDS)
    : new Set();
}
