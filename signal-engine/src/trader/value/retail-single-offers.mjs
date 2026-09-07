import { createHash } from 'node:crypto';

const VERIFIED = 'verified';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalized(value) {
  return text(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ');
}

function normalizedCollectorNumber(value) {
  const raw = text(value).toUpperCase();
  const match = raw.match(/^0*(\d+)([A-Z]?)$/);
  return match ? `${Number(match[1])}${match[2]}` : raw;
}

function stableId(prefix, ...parts) {
  const digest = createHash('sha256').update(parts.map((part) => text(part)).join('\u001f')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function exactVariantLanes(candidate, binding) {
  const label = normalized(candidate?.variantTitle);
  const entries = Object.entries(binding?.variantLanes || {});
  const match = entries.find(([sourceLabel]) => normalized(sourceLabel) === label);
  return match ? Object.freeze(match[1].map((lane) => normalized(lane)).filter(Boolean)) : Object.freeze([]);
}

function exactCollectorNumber(candidate) {
  const hints = Array.isArray(candidate?.identityHints?.collectorNumbers)
    ? candidate.identityHints.collectorNumbers
    : [];
  const unique = [...new Set(hints.map((hint) => normalizedCollectorNumber(hint?.cardNumber)).filter(Boolean))];
  return unique.length === 1 ? unique[0] : null;
}

function titleCardName(candidate, binding, collectorNumber) {
  const title = text(candidate?.productTitle);
  const leading = title.match(/^#\s*0*(\d+[a-z]?)\s+(.+)$/i);
  if (!leading || normalizedCollectorNumber(leading[1]) !== collectorNumber) return null;
  let remainder = text(leading[2]);
  const suffixes = [...(binding?.titleSuffixes || [])].sort((a, b) => text(b).length - text(a).length);
  const suffix = suffixes.find((value) => {
    const clean = text(value);
    return clean && normalized(remainder).endsWith(normalized(clean));
  });
  if (!suffix) return null;
  remainder = remainder.slice(0, remainder.length - text(suffix).length).trim();
  remainder = remainder.replace(/\s+0*\d+[a-z]?\s*\/\s*\d+\s*$/i, '').trim();
  return remainder || null;
}

function reviewedCardName(sourceName, binding, collectorNumber) {
  const aliases = binding?.cardNameAliases?.[collectorNumber] || {};
  const match = Object.entries(aliases).find(([source]) => normalized(source) === normalized(sourceName));
  return match ? text(match[1]) : sourceName;
}

function quarantine(candidate, reason, evidence = {}) {
  return Object.freeze({
    status: 'quarantined',
    reason,
    candidate,
    exactIdentityVerified: false,
    evidence: Object.freeze(evidence),
  });
}

/**
 * Resolve one retailer single against a reviewed set binding and verified
 * canonical cards. This is intentionally deterministic: exact collection,
 * collector number, finish lane, language, and normalized card name must all
 * agree. Retailer search titles never become canonical identity authority.
 */
export function resolveExactRetailSingleCandidate(candidate, {
  binding,
  canonicalCards,
  languageCode = 'en',
} = {}) {
  if (!candidate || typeof candidate !== 'object') throw new TypeError('candidate is required');
  if (!binding || typeof binding !== 'object') throw new TypeError('reviewed set binding is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');

  if (candidate.verificationStatus !== 'staged' || candidate.exactIdentityVerified !== false) {
    return quarantine(candidate, 'candidate_not_staged');
  }
  if (text(candidate.tcg).toLowerCase() !== text(binding.tcgCode).toLowerCase()
      || text(candidate.sourceCollectionHandle) !== text(binding.collectionHandle)) {
    return quarantine(candidate, 'reviewed_set_binding_mismatch');
  }

  const collectorNumber = exactCollectorNumber(candidate);
  if (!collectorNumber) return quarantine(candidate, 'collector_number_missing_or_conflicting');
  const sourceCardName = titleCardName(candidate, binding, collectorNumber);
  if (!sourceCardName) return quarantine(candidate, 'card_name_evidence_missing');
  const cardName = reviewedCardName(sourceCardName, binding, collectorNumber);
  const variantLanes = exactVariantLanes(candidate, binding);
  if (!variantLanes.length) return quarantine(candidate, 'finish_unrecognized', { variantTitle: candidate.variantTitle ?? null });

  const candidates = canonicalCards.filter((card) => (
    card?.verificationStatus === VERIFIED
    && text(card.setId) === text(binding.canonicalSetId)
    && text(card.tcgCode).toLowerCase() === text(binding.tcgCode).toLowerCase()
    && text(card.languageCode).toLowerCase() === text(languageCode).toLowerCase()
    && normalizedCollectorNumber(card.collectorNumber) === collectorNumber
    && variantLanes.includes(normalized(card.variantCode))
    && normalized(card.name) === normalized(cardName)
    && text(card.fateCardId ?? card.id)
  ));

  if (!candidates.length) {
    return quarantine(candidate, 'exact_identity_not_found', { collectorNumber, cardName, variantLanes });
  }
  if (candidates.length !== 1) {
    return quarantine(candidate, 'exact_identity_conflict', {
      collectorNumber,
      cardName,
      variantLanes,
      candidateCardIdentityIds: candidates.map((card) => text(card.fateCardId ?? card.id)),
    });
  }

  const card = candidates[0];
  const cardIdentityId = text(card.fateCardId ?? card.id);
  return Object.freeze({
    status: VERIFIED,
    reason: null,
    candidate,
    card,
    cardIdentityId,
    canonicalSetId: text(binding.canonicalSetId),
    collectorNumber,
    marketSegmentKey: normalized(card.variantCode),
    conditionCode: 'unspecified',
    languageCode: text(languageCode).toLowerCase(),
    exactIdentityVerified: true,
    evidence: Object.freeze({
      policy: 'reviewed_set_plus_exact_number_finish_language_and_name',
      collectionHandle: text(binding.collectionHandle),
      bindingReviewedAt: text(binding.reviewedAt) || null,
      sourceCardName,
      cardName,
      collectorNumber,
      sourceVariantLabel: text(candidate.variantTitle) || null,
      canonicalVariantCode: normalized(card.variantCode),
    }),
  });
}

export function buildVerifiedRetailSingleRecords(resolution, { now = Date.now() } = {}) {
  if (resolution?.status !== VERIFIED || resolution?.exactIdentityVerified !== true) {
    throw new TypeError('A verified exact retail-single resolution is required');
  }
  const candidate = resolution.candidate;
  const observedSeconds = Number(candidate.observedAt);
  if (!Number.isInteger(observedSeconds) || observedSeconds <= 0) throw new TypeError('candidate observedAt is required');
  const verifiedAt = Number(now);
  const productId = stableId('fdproduct', 'single-card', resolution.cardIdentityId);
  const offerId = stableId('fdoffer', candidate.retailerId, candidate.retailerVariantId);
  const observationId = stableId('fdobservation', offerId, String(observedSeconds));
  const mappingId = stableId('fdretailmap', resolution.cardIdentityId, offerId);
  const productTitle = `${text(resolution.card.name)} #${text(resolution.card.collectorNumber)}`;
  const product = Object.freeze({
    id: productId,
    canonicalKey: `single:${resolution.cardIdentityId}`,
    title: productTitle,
    productType: 'SINGLE',
    tcg: text(candidate.tcg).toLowerCase(),
    officialRrpPence: null,
    rrpSource: null,
    rrpObservedAt: null,
    firstSeenAt: observedSeconds,
    updatedAt: observedSeconds,
  });
  const offer = Object.freeze({
    offerId,
    productId,
    retailerId: text(candidate.retailerId),
    retailerName: text(candidate.retailerName),
    retailerSku: text(candidate.retailerSku),
    title: text(candidate.title),
    url: text(candidate.url),
    imageUrl: text(candidate.imageUrl) || null,
    pricePence: Number.isInteger(candidate.pricePence) ? candidate.pricePence : null,
    postagePence: null,
    gtin: null,
    stockStatus: text(candidate.stockStatus),
    stockConfidence: Number(candidate.stockConfidence),
    stockQuantity: null,
    everAvailableAt: candidate.stockStatus === 'in_stock' ? observedSeconds : null,
    firstSeenAt: observedSeconds,
    lastSeenAt: observedSeconds,
  });
  const observation = Object.freeze({
    id: observationId,
    offerId,
    retailerId: offer.retailerId,
    observedAt: observedSeconds,
    stockStatus: offer.stockStatus,
    stockConfidence: offer.stockConfidence,
    stockQuantity: null,
    pricePence: offer.pricePence,
    evidence: Object.freeze([Object.freeze({
      type: 'retailer_single_source',
      sourceKind: text(candidate.sourceKind),
      sourceCollectionUrl: text(candidate.sourceCollectionUrl),
      retailerProductId: text(candidate.retailerProductId),
      retailerVariantId: text(candidate.retailerVariantId),
    })]),
  });
  const mapping = Object.freeze({
    id: mappingId,
    cardIdentityId: resolution.cardIdentityId,
    offerId,
    marketSegmentKey: resolution.marketSegmentKey,
    conditionCode: resolution.conditionCode,
    languageCode: resolution.languageCode,
    verificationStatus: VERIFIED,
    verifiedAt,
    evidence: Object.freeze([resolution.evidence]),
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
  });
  return Object.freeze({ product, offer, observation, mapping });
}

export function resolveRetailSingleBatch(candidates, options = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const verified = [];
  const quarantined = [];
  for (const candidate of candidates) {
    const resolution = resolveExactRetailSingleCandidate(candidate, options);
    if (resolution.status === VERIFIED) verified.push(resolution);
    else quarantined.push(resolution);
  }
  return Object.freeze({
    verified: Object.freeze(verified),
    quarantined: Object.freeze(quarantined),
    counts: Object.freeze({
      candidates: candidates.length,
      verified: verified.length,
      quarantined: quarantined.length,
      buyableVerified: verified.filter((item) => item.candidate.stockStatus === 'in_stock').length,
    }),
  });
}

export const __test = Object.freeze({
  exactCollectorNumber,
  exactVariantLanes,
  normalizedCollectorNumber,
  stableId,
  titleCardName,
  reviewedCardName,
});
