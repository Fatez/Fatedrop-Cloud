import {
  makeMarketIngestRunId,
  normaliseMarketIngestRejection,
  normaliseMarketIngestRun,
  normaliseMarketObservationCandidate,
} from './market-observation.mjs';

export const CARDMARKET_SOURCE_NAME = 'cardmarket';
export const CARDMARKET_NATIVE_CURRENCY = 'EUR';
export const CARDMARKET_PRICE_LANES = Object.freeze(['standard', 'holo']);

const LANE_FIELDS = Object.freeze({
  standard: Object.freeze({
    avgLifetime: 'avg',
    lowPrice: 'low',
    trendPrice: 'trend',
    avg1d: 'avg1',
    avg7d: 'avg7',
    avg30d: 'avg30',
  }),
  holo: Object.freeze({
    avgLifetime: 'avg-holo',
    lowPrice: 'low-holo',
    trendPrice: 'trend-holo',
    avg1d: 'avg1-holo',
    avg7d: 'avg7-holo',
    avg30d: 'avg30-holo',
  }),
});

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requirePositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return number;
}

function optionalNonNegativePrice(value, field) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return number;
}

function normaliseProviderDate(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('priceGuide.createdAt is required');
  }
  const text = value.trim();
  const withColonOffset = text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const millis = Date.parse(withColonOffset);
  if (!Number.isFinite(millis)) throw new TypeError('priceGuide.createdAt is invalid');
  return millis;
}

function normaliseLane(lane) {
  const value = String(lane || '').trim().toLowerCase();
  if (!CARDMARKET_PRICE_LANES.includes(value)) {
    throw new TypeError(`unsupported Cardmarket price lane: ${lane}`);
  }
  return value;
}

function requireMapping(mapping, row, lane) {
  requireObject(mapping, 'mapping');
  const productId = String(requirePositiveInteger(row.idProduct, 'row.idProduct'));
  if (mapping.sourceName !== CARDMARKET_SOURCE_NAME) {
    throw new TypeError('Cardmarket evidence requires a Cardmarket source mapping');
  }
  if (String(mapping.sourceRecordId) !== productId) {
    throw new TypeError('Cardmarket source mapping product mismatch');
  }
  if (typeof mapping.id !== 'string' || mapping.id.trim() === '') {
    throw new TypeError('mapping.id is required');
  }
  if (typeof mapping.cardIdentityId !== 'string' || mapping.cardIdentityId.trim() === '') {
    throw new TypeError('mapping.cardIdentityId is required');
  }
  if (typeof mapping.sourceVariantKey !== 'string' || mapping.sourceVariantKey.trim() === '') {
    throw new TypeError('mapping.sourceVariantKey is required');
  }

  // The caller must resolve a mapping for the requested price lane. We retain
  // the lane separately rather than deriving FateDrop's canonical variant from
  // Cardmarket pricing fields.
  return Object.freeze({
    id: mapping.id.trim(),
    cardIdentityId: mapping.cardIdentityId.trim(),
    sourceName: CARDMARKET_SOURCE_NAME,
    sourceRecordId: productId,
    sourceVariantKey: mapping.sourceVariantKey.trim(),
    priceGuideLane: lane,
  });
}

function lanePrices(row, lane) {
  const fields = LANE_FIELDS[lane];
  return Object.freeze(Object.fromEntries(
    Object.entries(fields).map(([target, source]) => [
      target,
      optionalNonNegativePrice(row[source], `row.${source}`),
    ]),
  ));
}

export function hasMeaningfulCardmarketLane(row, lane) {
  requireObject(row, 'row');
  const normalizedLane = normaliseLane(lane);
  const prices = lanePrices(row, normalizedLane);

  // Cardmarket can emit zero placeholders for a lane that has no useful market.
  // A lane needs at least one positive signal before it becomes canonical market
  // evidence. The raw row can still be retained in an ingest rejection.
  return Object.values(prices).some((value) => value != null && value > 0);
}

export function adaptCardmarketPriceGuideSnapshot(payload) {
  requireObject(payload, 'priceGuide');
  const version = requirePositiveInteger(payload.version, 'priceGuide.version');
  const sourceEffectiveAt = normaliseProviderDate(payload.createdAt);
  const priceGuides = requireArray(payload.priceGuides, 'priceGuide.priceGuides');
  const providerCreatedAt = new Date(sourceEffectiveAt).toISOString();
  const sourceSnapshotId = `pokemon-price-guide-v${version}-${providerCreatedAt}`;

  return Object.freeze({
    sourceName: CARDMARKET_SOURCE_NAME,
    sourceVersion: String(version),
    sourceSnapshotId,
    sourceEffectiveAt,
    currencyCode: CARDMARKET_NATIVE_CURRENCY,
    priceGuides,
  });
}

export function adaptCardmarketPriceGuideRow(row, {
  snapshot,
  mapping,
  lane,
  observedAt = Date.now(),
} = {}) {
  requireObject(row, 'row');
  requireObject(snapshot, 'snapshot');
  const normalizedLane = normaliseLane(lane);
  if (snapshot.sourceName !== CARDMARKET_SOURCE_NAME) {
    throw new TypeError('snapshot must be a Cardmarket snapshot');
  }
  if (!hasMeaningfulCardmarketLane(row, normalizedLane)) return null;

  const resolvedMapping = requireMapping(mapping, row, normalizedLane);
  const prices = lanePrices(row, normalizedLane);
  const idCategory = row.idCategory == null
    ? null
    : requirePositiveInteger(row.idCategory, 'row.idCategory');

  return normaliseMarketObservationCandidate({
    ingestRunId: makeMarketIngestRunId(snapshot.sourceName, snapshot.sourceSnapshotId),
    cardIdentityId: resolvedMapping.cardIdentityId,
    cardSourceMappingId: resolvedMapping.id,
    sourceName: snapshot.sourceName,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    sourceRecordId: resolvedMapping.sourceRecordId,
    sourceVariantKey: resolvedMapping.sourceVariantKey,
    marketSegmentKey: normalizedLane,
    conditionCode: 'unspecified',
    currencyCode: snapshot.currencyCode,
    observedAt,
    sourceEffectiveAt: snapshot.sourceEffectiveAt,
    ...prices,
    metricsJson: {
      providerCategoryId: idCategory,
      priceGuideLane: normalizedLane,
    },
    rawPayload: row,
  });
}

export async function buildCardmarketPriceGuideBatch(payload, {
  resolveMapping,
  observedAt = Date.now(),
  lanes = CARDMARKET_PRICE_LANES,
} = {}) {
  if (typeof resolveMapping !== 'function') {
    throw new TypeError('resolveMapping function is required');
  }

  const snapshot = adaptCardmarketPriceGuideSnapshot(payload);
  const selectedLanes = Object.freeze([...new Set(lanes.map(normaliseLane))]);
  const ingestRunId = makeMarketIngestRunId(snapshot.sourceName, snapshot.sourceSnapshotId);
  const observations = [];
  const rejections = [];

  for (const row of snapshot.priceGuides) {
    requireObject(row, 'priceGuide.priceGuides[]');
    const sourceRecordId = String(requirePositiveInteger(row.idProduct, 'row.idProduct'));

    for (const lane of selectedLanes) {
      if (!hasMeaningfulCardmarketLane(row, lane)) continue;

      const mapping = await resolveMapping({
        sourceName: CARDMARKET_SOURCE_NAME,
        sourceRecordId,
        priceGuideLane: lane,
      });

      if (!mapping) {
        rejections.push(normaliseMarketIngestRejection({
          ingestRunId,
          sourceName: CARDMARKET_SOURCE_NAME,
          sourceSnapshotId: snapshot.sourceSnapshotId,
          sourceRecordId,
          sourceVariantKey: lane,
          rejectionCode: 'identity_unresolved',
          rejectionDetail: `No exact canonical mapping resolved for Cardmarket ${lane} price lane`,
          rawPayload: {
            priceGuideLane: lane,
            row,
          },
          createdAt: observedAt,
        }));
        continue;
      }

      try {
        const observation = adaptCardmarketPriceGuideRow(row, {
          snapshot,
          mapping,
          lane,
          observedAt,
        });
        if (observation) observations.push(observation);
      } catch (error) {
        rejections.push(normaliseMarketIngestRejection({
          ingestRunId,
          sourceName: CARDMARKET_SOURCE_NAME,
          sourceSnapshotId: snapshot.sourceSnapshotId,
          sourceRecordId,
          sourceVariantKey: mapping?.sourceVariantKey ?? lane,
          rejectionCode: 'mapping_conflict',
          rejectionDetail: error instanceof Error ? error.message : String(error),
          rawPayload: {
            priceGuideLane: lane,
            row,
          },
          createdAt: observedAt,
        }));
      }
    }
  }

  const terminalAt = Number(observedAt);
  const run = normaliseMarketIngestRun({
    sourceName: snapshot.sourceName,
    sourceSnapshotId: snapshot.sourceSnapshotId,
    sourceVersion: snapshot.sourceVersion,
    startedAt: terminalAt,
    completedAt: terminalAt,
    status: rejections.length > 0 ? 'partial' : 'completed',
    recordsSeen: observations.length + rejections.length,
    recordsAccepted: observations.length,
    recordsRejected: rejections.length,
    metadataJson: {
      providerCreatedAt: new Date(snapshot.sourceEffectiveAt).toISOString(),
      sourceCurrency: snapshot.currencyCode,
      sourceRows: snapshot.priceGuides.length,
      selectedLanes,
    },
    createdAt: terminalAt,
  });

  return Object.freeze({
    snapshot,
    run,
    observations: Object.freeze(observations),
    rejections: Object.freeze(rejections),
  });
}
