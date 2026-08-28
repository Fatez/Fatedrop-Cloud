import { createHash } from 'node:crypto';

export const MARKET_INGEST_STATUSES = Object.freeze([
  'running',
  'completed',
  'partial',
  'failed',
]);

const STANDARD_PRICE_FIELDS = Object.freeze([
  'marketPrice',
  'lowPrice',
  'trendPrice',
  'avg1d',
  'avg7d',
  'avg30d',
  'avgLifetime',
  'excellentPlusLow',
]);

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function requireTimestamp(value, field) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive timestamp`);
  }
  return Math.trunc(value);
}

function optionalTimestamp(value, field) {
  if (value == null) return null;
  return requireTimestamp(value, field);
}

function requireCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function digest(prefix, value) {
  const hash = createHash('sha256').update(value).digest('hex');
  return prefix ? `${prefix}_${hash.slice(0, 24)}` : hash;
}

function stableId(prefix, parts) {
  return digest(prefix, parts.map((part) => String(part ?? '')).join('|'));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalJson(value));
}

function plainObject(value, field) {
  if (value == null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return Object.freeze({ ...value });
}

function normaliseLabel(value, fallback, field) {
  const text = optionalText(value) ?? optionalText(fallback);
  if (!text) throw new TypeError(`${field} is required`);
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9._+/=-]+$/.test(normalized)) {
    throw new TypeError(`${field} contains unsupported characters`);
  }
  return normalized;
}

function normaliseCurrency(value) {
  const currencyCode = requireText(value, 'currencyCode').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new TypeError('currencyCode must be an ISO-style 3-letter code');
  }
  return currencyCode;
}

function normalisePrice(value, field) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return number;
}

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function makeMarketIngestRunId(sourceName, sourceSnapshotId) {
  return stableId('fdmarketrun', [
    requireText(sourceName, 'sourceName'),
    requireText(sourceSnapshotId, 'sourceSnapshotId'),
  ]);
}

export function normaliseMarketIngestRun(input) {
  if (!input || typeof input !== 'object') throw new TypeError('ingest run is required');

  const sourceName = requireText(input.sourceName, 'sourceName');
  const sourceSnapshotId = requireText(input.sourceSnapshotId, 'sourceSnapshotId');
  const startedAt = requireTimestamp(input.startedAt ?? Date.now(), 'startedAt');
  const status = optionalText(input.status) ?? 'running';
  if (!MARKET_INGEST_STATUSES.includes(status)) throw new TypeError('unsupported ingest status');

  const completedAt = optionalTimestamp(input.completedAt, 'completedAt');
  if (status !== 'running' && completedAt == null) {
    throw new TypeError('completedAt is required for a terminal ingest status');
  }

  const recordsSeen = requireCount(input.recordsSeen ?? 0, 'recordsSeen');
  const recordsAccepted = requireCount(input.recordsAccepted ?? 0, 'recordsAccepted');
  const recordsRejected = requireCount(input.recordsRejected ?? 0, 'recordsRejected');
  if (recordsAccepted + recordsRejected > recordsSeen) {
    throw new TypeError('accepted and rejected records cannot exceed recordsSeen');
  }

  return Object.freeze({
    id: makeMarketIngestRunId(sourceName, sourceSnapshotId),
    sourceName,
    sourceSnapshotId,
    sourceVersion: optionalText(input.sourceVersion),
    startedAt,
    completedAt,
    status,
    recordsSeen,
    recordsAccepted,
    recordsRejected,
    metadataJson: plainObject(input.metadataJson, 'metadataJson'),
    createdAt: requireTimestamp(input.createdAt ?? startedAt, 'createdAt'),
  });
}

export function makeMarketObservationId(input) {
  return stableId('fdmarketobs', [
    requireText(input?.sourceName, 'sourceName'),
    requireText(input?.sourceSnapshotId, 'sourceSnapshotId'),
    requireText(input?.sourceRecordId, 'sourceRecordId'),
    requireText(input?.sourceVariantKey, 'sourceVariantKey'),
    normaliseLabel(input?.marketSegmentKey, 'default', 'marketSegmentKey'),
    normaliseLabel(input?.conditionCode, 'unspecified', 'conditionCode'),
  ]);
}

export function normaliseMarketObservationCandidate(input) {
  if (!input || typeof input !== 'object') throw new TypeError('market observation is required');

  const observedAt = requireTimestamp(input.observedAt ?? Date.now(), 'observedAt');
  const sourceEffectiveAt = optionalTimestamp(input.sourceEffectiveAt, 'sourceEffectiveAt');
  const sourceName = requireText(input.sourceName, 'sourceName');
  const sourceSnapshotId = requireText(input.sourceSnapshotId, 'sourceSnapshotId');
  const sourceRecordId = requireText(input.sourceRecordId, 'sourceRecordId');
  const sourceVariantKey = requireText(input.sourceVariantKey, 'sourceVariantKey');
  const marketSegmentKey = normaliseLabel(input.marketSegmentKey, 'default', 'marketSegmentKey');
  const conditionCode = normaliseLabel(input.conditionCode, 'unspecified', 'conditionCode');
  const currencyCode = normaliseCurrency(input.currencyCode);
  const cardIdentityId = requireText(input.cardIdentityId, 'cardIdentityId');
  const cardSourceMappingId = requireText(input.cardSourceMappingId, 'cardSourceMappingId');

  const prices = Object.fromEntries(
    STANDARD_PRICE_FIELDS.map((field) => [field, normalisePrice(input[field], field)]),
  );
  const metricsJson = plainObject(input.metricsJson, 'metricsJson');
  const rawPayload = plainObject(input.rawPayload, 'rawPayload');
  if (!STANDARD_PRICE_FIELDS.some((field) => prices[field] != null)
    && Object.keys(metricsJson).length === 0) {
    throw new TypeError('at least one market metric is required');
  }

  const ingestRunId = optionalText(input.ingestRunId)
    ?? makeMarketIngestRunId(sourceName, sourceSnapshotId);
  const marketDay = utcDay(sourceEffectiveAt ?? observedAt);

  const contentFingerprint = digest(null, stableJson({
    ingestRunId,
    cardIdentityId,
    cardSourceMappingId,
    sourceName,
    sourceSnapshotId,
    sourceRecordId,
    sourceVariantKey,
    marketSegmentKey,
    conditionCode,
    currencyCode,
    observedAt,
    sourceEffectiveAt,
    marketDay,
    prices,
    metricsJson,
    rawPayload,
  }));

  return Object.freeze({
    id: makeMarketObservationId({
      sourceName,
      sourceSnapshotId,
      sourceRecordId,
      sourceVariantKey,
      marketSegmentKey,
      conditionCode,
    }),
    ingestRunId,
    cardIdentityId,
    cardSourceMappingId,
    sourceName,
    sourceSnapshotId,
    sourceRecordId,
    sourceVariantKey,
    marketSegmentKey,
    conditionCode,
    currencyCode,
    observedAt,
    sourceEffectiveAt,
    marketDay,
    ...prices,
    metricsJson,
    rawPayload,
    contentFingerprint,
    createdAt: requireTimestamp(input.createdAt ?? observedAt, 'createdAt'),
  });
}

export function normaliseMarketIngestRejection(input) {
  if (!input || typeof input !== 'object') throw new TypeError('market rejection is required');

  const sourceName = requireText(input.sourceName, 'sourceName');
  const sourceSnapshotId = requireText(input.sourceSnapshotId, 'sourceSnapshotId');
  const sourceRecordId = optionalText(input.sourceRecordId);
  const sourceVariantKey = optionalText(input.sourceVariantKey);
  const rejectionCode = normaliseLabel(input.rejectionCode, null, 'rejectionCode');
  const createdAt = requireTimestamp(input.createdAt ?? Date.now(), 'createdAt');
  const ingestRunId = optionalText(input.ingestRunId)
    ?? makeMarketIngestRunId(sourceName, sourceSnapshotId);

  return Object.freeze({
    id: stableId('fdmarketreject', [
      ingestRunId,
      sourceRecordId,
      sourceVariantKey,
      rejectionCode,
    ]),
    ingestRunId,
    sourceName,
    sourceSnapshotId,
    sourceRecordId,
    sourceVariantKey,
    rejectionCode,
    rejectionDetail: optionalText(input.rejectionDetail),
    rawPayload: plainObject(input.rawPayload, 'rawPayload'),
    createdAt,
  });
}
