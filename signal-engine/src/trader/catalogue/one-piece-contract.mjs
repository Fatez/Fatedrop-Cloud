import { requireKnownTcg } from '../tcg-registry.mjs';

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  return value == null || String(value).trim() === '' ? null : String(value).trim();
}

function optionalInteger(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return number;
}

function optionalTimestamp(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${field} must be a positive timestamp`);
  return number;
}

function sourceIdentity(record, options) {
  return {
    sourceName: requireText(options?.sourceName, 'sourceName'),
    sourceRecordId: requireText(record.sourceRecordId, 'sourceRecordId'),
    sourceVersion: optionalText(options?.sourceVersion),
    sourceUrl: optionalText(record.sourceUrl),
  };
}

export function adaptOnePieceSetEvidence(record, options = {}) {
  requireObject(record, 'record');
  requireKnownTcg('one-piece');

  return Object.freeze({
    ...sourceIdentity(record, options),
    tcgCode: 'one-piece',
    marketCode: requireText(record.marketCode, 'marketCode'),
    languageCode: requireText(record.languageCode, 'languageCode'),
    seriesName: requireText(record.seriesName, 'seriesName'),
    setName: requireText(record.setName, 'setName'),
    sourceSetCode: requireText(record.sourceSetCode, 'sourceSetCode'),
    printedTotal: optionalInteger(record.printedTotal, 'printedTotal'),
    total: optionalInteger(record.total, 'total'),
    releasedAt: optionalTimestamp(record.releasedAt, 'releasedAt'),
  });
}

export function adaptOnePieceCardEvidence(record, options = {}) {
  requireObject(record, 'record');
  requireKnownTcg('one-piece');

  return Object.freeze({
    ...sourceIdentity(record, options),
    tcgCode: 'one-piece',
    marketCode: requireText(record.marketCode, 'marketCode'),
    languageCode: requireText(record.languageCode, 'languageCode'),
    seriesName: requireText(record.seriesName, 'seriesName'),
    setName: requireText(record.setName, 'setName'),
    sourceSetCode: requireText(record.sourceSetCode, 'sourceSetCode'),
    collectorNumber: requireText(record.collectorNumber, 'collectorNumber'),
    printingCode: requireText(record.printingCode, 'printingCode'),
    name: requireText(record.name, 'name'),
    rarity: optionalText(record.rarity),
    supertype: optionalText(record.supertype),
    subtypes: Object.freeze(Array.isArray(record.subtypes) ? [...record.subtypes] : []),
    attributes: Object.freeze(record.attributes && typeof record.attributes === 'object' && !Array.isArray(record.attributes)
      ? { ...record.attributes }
      : {}),
    // Variant evidence is intentionally not guessed. A future source adapter must
    // prove finish/parallel treatment before an exact FateDrop card identity is verified.
    variantEvidenceAvailable: record.variantEvidenceAvailable === true,
  });
}
