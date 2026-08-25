import { createHash } from 'node:crypto';

export const CARD_VERIFICATION_STATES = Object.freeze([
  'staged',
  'verified',
  'conflict',
  'quarantined',
  'retired',
]);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function normaliseKeyPart(value, field) {
  const normalized = requireText(value, field)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '-');

  if (!/^[a-z0-9._+/=-]+$/.test(normalized)) {
    throw new TypeError(`${field} contains unsupported identity characters`);
  }

  return normalized;
}

function digestId(prefix, canonicalKey) {
  const digest = createHash('sha256').update(canonicalKey).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

export function makeFateTcgId(tcgCode) {
  return `fdtcg_${normaliseKeyPart(tcgCode, 'tcgCode')}`;
}

export function makeCanonicalPrintingKey(input) {
  const tcgCode = normaliseKeyPart(input?.tcgCode, 'tcgCode');
  const seriesCode = normaliseKeyPart(input?.seriesCode, 'seriesCode');
  const setCode = normaliseKeyPart(input?.setCode, 'setCode');
  const collectorNumber = normaliseKeyPart(input?.collectorNumber, 'collectorNumber');
  const printingCode = normaliseKeyPart(input?.printingCode, 'printingCode');
  return ['printing:v1', tcgCode, seriesCode, setCode, collectorNumber, printingCode].join(':');
}

export function makeFatePrintingId(input) {
  const canonicalKey = typeof input === 'string' ? input : makeCanonicalPrintingKey(input);
  return digestId('fdprinting', canonicalKey);
}

export function makeCanonicalCardKey(input) {
  const tcgCode = normaliseKeyPart(input?.tcgCode, 'tcgCode');
  const seriesCode = normaliseKeyPart(input?.seriesCode, 'seriesCode');
  const setCode = normaliseKeyPart(input?.setCode, 'setCode');
  const collectorNumber = normaliseKeyPart(input?.collectorNumber, 'collectorNumber');
  const printingCode = normaliseKeyPart(input?.printingCode, 'printingCode');
  const variantCode = normaliseKeyPart(input?.variantCode, 'variantCode');
  const languageCode = normaliseKeyPart(input?.languageCode, 'languageCode');

  return [
    'card:v1',
    tcgCode,
    seriesCode,
    setCode,
    collectorNumber,
    printingCode,
    variantCode,
    languageCode,
  ].join(':');
}

export function makeFateCardId(input) {
  const canonicalKey = typeof input === 'string' ? input : makeCanonicalCardKey(input);
  return digestId('fdcard', canonicalKey);
}

export function normaliseSourceCardCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('candidate is required');
  }

  const sourceName = requireText(candidate.sourceName, 'sourceName');
  const sourceRecordId = requireText(candidate.sourceRecordId, 'sourceRecordId');
  const name = requireText(candidate.name, 'name');

  // Deliberately require adapters to assert printing/variant/language explicitly.
  // The shared identity layer must never guess a missing variant as "standard".
  const identityInput = {
    tcgCode: requireText(candidate.tcgCode, 'tcgCode'),
    seriesCode: requireText(candidate.seriesCode, 'seriesCode'),
    setCode: requireText(candidate.setCode, 'setCode'),
    collectorNumber: requireText(candidate.collectorNumber, 'collectorNumber'),
    printingCode: requireText(candidate.printingCode, 'printingCode'),
    variantCode: requireText(candidate.variantCode, 'variantCode'),
    languageCode: requireText(candidate.languageCode, 'languageCode'),
  };

  const canonicalKey = makeCanonicalCardKey(identityInput);
  const sourceVariantKey = candidate.sourceVariantKey
    ? normaliseKeyPart(candidate.sourceVariantKey, 'sourceVariantKey')
    : normaliseKeyPart(identityInput.variantCode, 'variantCode');

  return Object.freeze({
    fateCardId: makeFateCardId(canonicalKey),
    canonicalKey,
    verificationStatus: 'staged',
    sourceName,
    sourceRecordId,
    sourceVariantKey,
    sourceUrl: candidate.sourceUrl ? requireText(candidate.sourceUrl, 'sourceUrl') : null,
    sourceVersion: candidate.sourceVersion ? String(candidate.sourceVersion) : null,
    name,
    rarity: candidate.rarity ? String(candidate.rarity).trim() : null,
    supertype: candidate.supertype ? String(candidate.supertype).trim() : null,
    ...identityInput,
  });
}

export function identitiesMatch(left, right) {
  if (!left || !right) return false;
  const leftKey = typeof left === 'string' ? left : makeCanonicalCardKey(left);
  const rightKey = typeof right === 'string' ? right : makeCanonicalCardKey(right);
  return leftKey === rightKey;
}
