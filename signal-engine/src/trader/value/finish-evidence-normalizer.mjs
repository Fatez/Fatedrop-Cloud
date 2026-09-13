import { createHash } from 'node:crypto';

const sha256 = raw => createHash('sha256').update(raw).digest('hex');
const text = value => String(value ?? '').trim();
const folded = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const collector = value => text(value).toUpperCase().replace(/\s+/g, '').replace(/(^|[^0-9])0+(?=\d)/g, '$1');

export const PROVIDERS = Object.freeze(['scrydex', 'tcgplayer', 'cardmarket']);

export function verifySnapshot(snapshot) {
  if (!snapshot || !PROVIDERS.includes(snapshot.provider)) throw new Error('Unsupported finish evidence provider');
  if (!snapshot.cardIdentityId || !snapshot.sourceLocator || !snapshot.rawPayload) throw new Error('Snapshot scope is incomplete');
  if (!Number.isFinite(snapshot.observedAt)) throw new Error('Snapshot observedAt is required');
  const digest = sha256(snapshot.rawPayload);
  if (digest !== snapshot.payloadSha256) throw new Error('Snapshot SHA-256 mismatch');
  return { ...snapshot, payload: JSON.parse(snapshot.rawPayload) };
}

function exactTarget(target, snapshot) {
  return target?.cardIdentityId === snapshot.cardIdentityId
    && ['standard', 'holo', 'reverse_holo'].includes(target?.variantCode)
    && text(target.language || 'en').toLowerCase() === 'en'
    && Boolean(target.name)
    && Boolean(target.collectorNumber);
}

export function finishFromScrydexVariantName(value) {
  const key = text(value).replace(/[\s_-]+/g, '').toLowerCase();
  if (!key) return null;
  if (key.includes('firstedition')) return { finish: null, quarantined: 'first_edition' };
  if (key.includes('reverse') && key.includes('holofoil')) return { finish: 'reverse_holo', quarantined: null };
  if (key === 'holofoil' || key === 'unlimitedholofoil') return { finish: 'holo', quarantined: null };
  if (key === 'normal' || key === 'unlimitednormal') return { finish: 'standard', quarantined: null };
  return null;
}

export function finishFromTcgplayerSubtype(value) {
  const key = folded(value);
  if (key === 'normal') return 'standard';
  if (key === 'holofoil' || key === 'holo foil') return 'holo';
  if (key === 'reverse holofoil' || key === 'reverse holo foil') return 'reverse_holo';
  return null;
}

function cardmarketExplicitValues(payload) {
  const attributes = payload?.attributes && typeof payload.attributes === 'object' ? payload.attributes : {};
  const article = payload?.article && typeof payload.article === 'object' ? payload.article : {};
  return [payload?.finish, payload?.variant, attributes.finish, attributes.variant, article.finish, article.variant]
    .filter(value => typeof value === 'string' && value.trim());
}

export function finishFromCardmarketPayload(payload) {
  const explicit = new Set(cardmarketExplicitValues(payload).map(folded));
  const finishes = new Set();
  for (const value of explicit) {
    if (value === 'normal' || value === 'standard') finishes.add('standard');
    if (value === 'holo' || value === 'holofoil' || value === 'holo foil') finishes.add('holo');
    if (value === 'reverse holo' || value === 'reverse holofoil' || value === 'reverse holo foil') finishes.add('reverse_holo');
  }
  if (payload?.isFoil === true || payload?.isHolo === true) finishes.add('holo');
  if (payload?.isReverseFoil === true || payload?.isReverseHolo === true) finishes.add('reverse_holo');
  return [...finishes].sort();
}

function decision(target, snapshot, observedFinish) {
  return {
    cardIdentityId: target.cardIdentityId,
    finish: target.variantCode,
    language: target.language || 'en',
    edition: target.edition || 'unspecified',
    verdict: 'exists',
    basis: 'explicit_variant_record',
    reviewReference: `automated-explicit:${snapshot.provider}:${snapshot.payloadSha256}`,
    sourceLocator: snapshot.sourceLocator,
    snapshotSha256: snapshot.payloadSha256,
    observedFinish,
    reviewer: 'fatedrop-evidence-acquisition',
  };
}

export function normalizeExplicitFinishEvidence(target, rawSnapshot) {
  const snapshot = verifySnapshot(rawSnapshot);
  if (!exactTarget(target, snapshot)) return { decision: null, reason: 'target_scope_mismatch' };
  const payload = snapshot.payload;

  if (snapshot.provider === 'scrydex') {
    const expectedId = text(target.scrydexCardId || target.tcgdexCardId);
    if (!expectedId || text(payload?.id) !== expectedId) return { decision: null, reason: 'scrydex_id_mismatch' };
    if (collector(payload?.number ?? payload?.collector_number) !== collector(target.collectorNumber)) return { decision: null, reason: 'scrydex_collector_mismatch' };
    if (folded(payload?.name) !== folded(target.name)) return { decision: null, reason: 'scrydex_name_mismatch' };
    if (text(payload?.language_code).toUpperCase() !== 'EN') return { decision: null, reason: 'scrydex_language_mismatch' };
    const variants = Array.isArray(payload?.variants) ? payload.variants : [];
    const recognized = variants.map(v => ({ raw: v?.name, parsed: finishFromScrydexVariantName(v?.name) })).filter(v => v.parsed);
    const firstEditionOnly = recognized.length > 0 && recognized.every(v => v.parsed.quarantined === 'first_edition');
    if (firstEditionOnly) return { decision: null, reason: 'first_edition_quarantine' };
    const match = recognized.find(v => v.parsed.finish === target.variantCode && !v.parsed.quarantined);
    return match ? { decision: decision(target, snapshot, match.raw), reason: 'explicit_variant_record' }
      : { decision: null, reason: 'target_finish_not_explicit' };
  }

  if (snapshot.provider === 'tcgplayer') {
    if (target.tcgplayerExactCrosswalk !== true || target.tcgplayerProductId == null) return { decision: null, reason: 'tcgplayer_exact_crosswalk_required' };
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    const productRows = rows.filter(row => String(row?.productId) === String(target.tcgplayerProductId));
    const match = productRows.find(row => finishFromTcgplayerSubtype(row?.subTypeName) === target.variantCode);
    return match ? { decision: decision(target, snapshot, match.subTypeName), reason: 'explicit_variant_record' }
      : { decision: null, reason: 'target_finish_not_explicit' };
  }

  if (snapshot.provider === 'cardmarket') {
    if (target.cardmarketProductId == null || String(payload?.idProduct ?? payload?.productId) !== String(target.cardmarketProductId)) {
      return { decision: null, reason: 'cardmarket_product_mismatch' };
    }
    const finishes = finishFromCardmarketPayload(payload);
    return finishes.includes(target.variantCode)
      ? { decision: decision(target, snapshot, finishes.join(',')), reason: 'explicit_variant_record' }
      : { decision: null, reason: finishes.length ? 'other_explicit_finish_only' : 'no_explicit_finish_attribute' };
  }

  return { decision: null, reason: 'unsupported_provider' };
}

export function buildReviewedEvidence(targets, snapshots) {
  const byIdentity = new Map(targets.map(target => [target.cardIdentityId, target]));
  const decisions = [];
  const held = [];
  const snapshotMap = {};
  for (const rawSnapshot of snapshots) {
    const snapshot = verifySnapshot(rawSnapshot);
    snapshotMap[snapshot.payloadSha256] = snapshot.rawPayload;
    const target = byIdentity.get(snapshot.cardIdentityId);
    const result = normalizeExplicitFinishEvidence(target, snapshot);
    if (result.decision) decisions.push(result.decision);
    else held.push({ cardIdentityId: snapshot.cardIdentityId, provider: snapshot.provider, snapshotSha256: snapshot.payloadSha256, reason: result.reason });
  }
  decisions.sort((a, b) => `${a.cardIdentityId}|${a.snapshotSha256}`.localeCompare(`${b.cardIdentityId}|${b.snapshotSha256}`));
  held.sort((a, b) => `${a.cardIdentityId}|${a.provider}`.localeCompare(`${b.cardIdentityId}|${b.provider}`));
  return { decisions, held, snapshots: snapshotMap };
}
