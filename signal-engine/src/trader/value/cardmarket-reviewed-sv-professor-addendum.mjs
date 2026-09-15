// Separate audited addendum for Scarlet & Violet #189/#190.
// This deliberately does not alter the frozen SV70 manifest or digest.
// Both canonical FateDrop identities remain `holo`; only Cardmarket provider
// lane interpretation is exceptional: the ordinary/base numeric lane belongs
// to the inherent holo printing for these exact two products.
export const REVIEWED_SV_PROFESSOR_ADDENDUM_DIGEST = '85d7d4cfab79dcf072c8a008ef0b6d9bf6feaee5f867bc5311ffc45c2b0ead5c';

export const REVIEWED_SV_PROFESSOR_ADDENDUM = Object.freeze([
  Object.freeze({
    mappingId: 'fdcardmap_dd6a60541216bbd1dc8659b0',
    cardIdentityId: 'fdcard_f12e75f2d6e7fe6e839e4065',
    sourceRecordId: '689768',
    collectorNumber: '189',
    name: "Professor's Research (Professor Sada)",
    tcgdexCardId: 'sv01-189',
  }),
  Object.freeze({
    mappingId: 'fdcardmap_77ef684d1a301e93444ea0b6',
    cardIdentityId: 'fdcard_f64fbf1380e841b9c5d59e9c',
    sourceRecordId: '689769',
    collectorNumber: '190',
    name: "Professor's Research (Professor Turo)",
    tcgdexCardId: 'sv01-190',
  }),
]);

export const REVIEWED_SV_PROFESSOR_ADDENDUM_PRODUCT_IDS = Object.freeze(
  REVIEWED_SV_PROFESSOR_ADDENDUM.map((row) => row.sourceRecordId),
);

const byProductId = new Map(REVIEWED_SV_PROFESSOR_ADDENDUM.map((row) => [row.sourceRecordId, row]));

export function isReviewedSvProfessorAddendumProduct(id) {
  return byProductId.has(String(id));
}

export function validateReviewedSvProfessorAddendumMapping(row) {
  const expected = byProductId.get(String(row?.source_record_id));
  return Boolean(expected
    && row.id === expected.mappingId
    && row.card_identity_id === expected.cardIdentityId
    && row.source_variant_key === 'holo'
    && row.canonical_variant_code === 'holo'
    && row.language_code === 'en'
    && row.verification_status === 'verified');
}

export function validateReviewedSvProfessorAddendumMappings(rows) {
  const scoped = (rows || []).filter((row) => byProductId.has(String(row.source_record_id)) && row.source_variant_key === 'holo');
  if (scoped.length !== REVIEWED_SV_PROFESSOR_ADDENDUM.length) return new Set();
  const valid = new Set();
  for (const row of scoped) {
    if (!validateReviewedSvProfessorAddendumMapping(row)) return new Set();
    valid.add(String(row.source_record_id));
  }
  return valid.size === REVIEWED_SV_PROFESSOR_ADDENDUM.length ? valid : new Set();
}
