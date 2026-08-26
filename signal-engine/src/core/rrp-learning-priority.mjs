const VALUE_TYPES = new Set(["booster_box","elite_trainer_box","booster_bundle","collection_box","tin","booster_pack"]);
export function unresolvedRrpPriority({ occurrenceCount = 1, productType, hasAuthoritativeCandidate = false } = {}) {
  let score = Math.min(50, Math.max(1, Number(occurrenceCount) || 1) * 5);
  if (VALUE_TYPES.has(String(productType || ""))) score += 25;
  if (hasAuthoritativeCandidate) score += 25;
  return Math.min(100, score);
}
