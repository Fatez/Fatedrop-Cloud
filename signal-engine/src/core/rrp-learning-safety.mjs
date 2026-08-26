export function mayPersistVerifiedAlias({ confidence, authoritativeRrpPence, canonicalIdentityId } = {}) {
  return Number.isFinite(confidence) && confidence >= 0.99 && Number.isFinite(authoritativeRrpPence) && authoritativeRrpPence > 0 && Boolean(canonicalIdentityId);
}
