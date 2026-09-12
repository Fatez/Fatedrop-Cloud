import { createHash } from 'node:crypto';
// Exact baseline holo mappings retained by PR #483's guarded correction.
// TCGdex evidence pinned at 5b6a2859f454972477a9953ffe5cb554d24c45e9.
// This authorizes provider base-field interpretation, not stamped substitutions.
export const REVIEWED_CLEANED_HOLO_PRODUCT_IDS = Object.freeze(["567125","567126","574064","574065","658696","665266","682075","725122","725244","740733","760642","769214","769238","769308","780902","785852","785883","785895","785959","786003","794314","794373","794503","805395","805403","805412","805415","805419","805423","805430","805449","805453","805465","805474","817176","817182","817221","817266","817320","851204","869697","869766"]);
export const REVIEWED_CLEANED_HOLO_DIGEST = '15ced67833f23361f72ea5a6326ed20266d88e7d72b577847a070db68db1d020';
const ids = new Set(REVIEWED_CLEANED_HOLO_PRODUCT_IDS);
export const isReviewedCleanedHoloProduct = id => ids.has(String(id));
export function validateReviewedCleanedHoloMappings(rows) {
  const scoped = (rows || []).filter(r => ids.has(String(r.source_record_id)) && r.source_variant_key === 'holo');
  if (scoped.length !== 42 || new Set(scoped.map(r => String(r.source_record_id))).size !== 42) return new Set();
  if (scoped.some(r => r.canonical_variant_code !== 'holo' || r.language_code !== 'en' || r.verification_status !== 'verified')) return new Set();
  const lines = [...scoped].sort((a,b) => String(a.source_record_id).localeCompare(String(b.source_record_id)))
    .map(r => [r.id,r.card_identity_id,String(r.source_record_id),r.source_variant_key,r.canonical_variant_code,r.language_code,r.verification_status].join('|')).join('\n');
  if (createHash('sha256').update(lines).digest('hex') !== REVIEWED_CLEANED_HOLO_DIGEST) return new Set();
  // Competing normal ownership blocks only its product; unchanged peers remain eligible.
  return new Set(REVIEWED_CLEANED_HOLO_PRODUCT_IDS.filter(id => !(rows || []).some(r => String(r.source_record_id) === id && r.source_variant_key === 'normal')));
}
