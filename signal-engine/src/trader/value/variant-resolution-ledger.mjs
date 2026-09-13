import { createHash } from 'node:crypto';

export const STATES = Object.freeze(['ACTIVE_PRICED', 'ACTIVE_UNPRICED', 'INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE']);
export const snapshotHash = raw => createHash('sha256').update(raw).digest('hex');
export const providerVariantKey = (provider, productId, subtype, language, edition) =>
  JSON.stringify([provider, String(productId), subtype, language, edition]);

// These are reviewed evidence decisions, not untrusted provider fields.
// A raw subtype key, rarity or absence from a price dictionary is never such a decision.
function applicable(decision, row, snapshots) {
  return decision.cardIdentityId === row.cardIdentityId
    && decision.finish === row.variantCode
    && decision.language === row.language
    && decision.edition === row.edition
    && ['exists', 'does_not_exist'].includes(decision.verdict)
    && ['explicit_variant_record', 'exact_printing_checklist'].includes(decision.basis)
    && typeof decision.reviewReference === 'string' && decision.reviewReference.trim()
    && typeof decision.sourceLocator === 'string' && decision.sourceLocator.trim()
    && typeof snapshots[decision.snapshotSha256] === 'string'
    && snapshotHash(snapshots[decision.snapshotSha256]) === decision.snapshotSha256;
}

export function classifyVariant(row, { decisions = [], snapshots = {}, prices = [], now, maxAgeMs = 7 * 86400000 } = {}) {
  if (!row.cardIdentityId || !row.variantCode || !row.language || !row.edition) throw new Error('Exact variant scope is required');
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('Explicit classification time and positive freshness window required');
  const evidence = decisions.filter(d => applicable(d, row, snapshots));
  const verdicts = new Set(evidence.map(d => d.verdict));
  let state = 'UNRESOLVED_EVIDENCE', reason = 'existence_not_proven', price = null;
  if (verdicts.size > 1) reason = 'conflicting_existence_evidence';
  else if (verdicts.has('does_not_exist')) {
    state = 'INVALID_CATALOGUE_ENTRY'; reason = 'reviewed_nonexistence_evidence';
  } else if (verdicts.has('exists')) {
    const validPrices = prices.filter(p => p.cardIdentityId === row.cardIdentityId
      && p.finish === row.variantCode && p.language === row.language && p.edition === row.edition
      && p.exactMappingVerified === true && typeof p.mappingReviewReference === 'string' && p.mappingReviewReference.trim()
      && typeof p.provider === 'string' && p.provider.trim() && p.productId != null
      && typeof p.subtype === 'string' && p.subtype.trim()
      && typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency)
      && typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0
      && Number.isFinite(p.observedAt) && p.observedAt <= now && now - p.observedAt <= maxAgeMs
      && typeof snapshots[p.snapshotSha256] === 'string'
      && snapshotHash(snapshots[p.snapshotSha256]) === p.snapshotSha256)
      .sort((a,b) => b.observedAt-a.observedAt);
    const latest = validPrices.filter(p => p.observedAt === validPrices[0]?.observedAt);
    const values = new Set(latest.map(p => JSON.stringify([p.provider, p.productId, p.subtype, p.currency, p.amount])));
    if (values.size > 1) { state = 'ACTIVE_UNPRICED'; reason = 'conflicting_current_prices'; }
    else if (latest.length) { state = 'ACTIVE_PRICED'; reason = 'reviewed_existence_and_exact_current_price'; price = latest[0]; }
    else { state = 'ACTIVE_UNPRICED'; reason = 'no_supported_current_positive_price'; }
  }
  const targetKey = row.variantCode === 'standard' ? 'normal' : row.variantCode === 'holo' ? 'holofoil' : null;
  const sourceKeys = row.externalFinishKeys || [];
  return { ...row, state, reason, currentPrice: price,
    evidenceReferences: evidence.map(d => ({ snapshotSha256: d.snapshotSha256, sourceLocator: d.sourceLocator, reviewReference: d.reviewReference })),
    providerDiagnostic: sourceKeys.length === 0 ? 'no_recognised_finish_keys'
      : targetKey && !sourceKeys.includes(targetKey) ? 'other_finish_keys_only' : 'target_finish_key_present',
    productionWrites: false, proposedAction: state === 'INVALID_CATALOGUE_ENTRY' ? 'dependency_review_required_no_deletion' : 'review_only' };
}

export function buildResolutionLedger(rows, options) {
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.cardIdentityId)) throw new Error('Duplicate canonical identity in input');
    ids.add(row.cardIdentityId);
  }
  const results = rows.map(row => classifyVariant(row, options)).sort((a,b) => a.cardIdentityId.localeCompare(b.cardIdentityId));
  const counts = Object.fromEntries(STATES.map(s => [s, results.filter(r => r.state === s).length]));
  return { schemaVersion: 1, productionWrites: false, activationAuthorized: false, classified: results.length,
    resolved: results.length - counts.UNRESOLVED_EVIDENCE, counts, results };
}
