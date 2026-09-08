import { createHash } from 'node:crypto';
import {
  CARDMARKET_PRICE_LANES,
  buildCardmarketPriceGuideBatch,
} from './cardmarket-adapter.mjs';

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function normaliseVariantKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function classifyPreparedFinish(mapping) {
  const variantKey = normaliseVariantKey(mapping?.sourceVariantKey);
  if (!variantKey) return 'unknown';
  if (variantKey.includes('reverse')) return 'reverse-holo';
  if (variantKey.includes('holo')) return 'holo';
  if (variantKey.includes('standard') || variantKey.includes('normal') || variantKey.includes('non-holo')) return 'standard';
  return 'unknown';
}

export function validateCardmarketPriceLaneMapping(mapping, priceGuideLane) {
  requireObject(mapping, 'mapping');
  const lane = String(priceGuideLane || '').trim().toLowerCase();
  if (!CARDMARKET_PRICE_LANES.includes(lane)) {
    return Object.freeze({ ok: false, reason: 'unsupported_price_lane' });
  }

  const finish = classifyPreparedFinish(mapping);
  if (finish === 'reverse-holo') {
    return Object.freeze({ ok: false, reason: 'reverse_holo_requires_finish_specific_evidence' });
  }
  if (finish === 'holo' && lane !== 'holo') {
    return Object.freeze({ ok: false, reason: 'finish_price_lane_mismatch' });
  }
  if (finish === 'standard' && lane !== 'standard') {
    return Object.freeze({ ok: false, reason: 'finish_price_lane_mismatch' });
  }
  if (finish === 'unknown') {
    return Object.freeze({ ok: false, reason: 'finish_unconfirmed' });
  }
  return Object.freeze({ ok: true, reason: null });
}

function uniqueSorted(values) {
  return Object.freeze([...new Set(values)].sort());
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = selector(row) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))));
}

export async function prepareCardmarketEvidenceBundle(payload, {
  resolveMapping,
  sourceBytes = null,
  sourceLabel = 'cardmarket-price-guide',
  observedAt = Date.now(),
  tcgCode = 'pokemon',
} = {}) {
  requireObject(payload, 'payload');
  if (typeof resolveMapping !== 'function') throw new TypeError('resolveMapping function is required');

  const quarantinedMappings = [];
  const guardedResolveMapping = async (query) => {
    const mapping = await resolveMapping(query);
    if (!mapping) return null;
    const validation = validateCardmarketPriceLaneMapping(mapping, query.priceGuideLane);
    if (!validation.ok) {
      quarantinedMappings.push(Object.freeze({
        sourceName: query.sourceName,
        sourceRecordId: String(query.sourceRecordId),
        priceGuideLane: query.priceGuideLane,
        cardIdentityId: typeof mapping.cardIdentityId === 'string' ? mapping.cardIdentityId : null,
        cardSourceMappingId: typeof mapping.id === 'string' ? mapping.id : null,
        sourceVariantKey: typeof mapping.sourceVariantKey === 'string' ? mapping.sourceVariantKey : null,
        reason: validation.reason,
      }));
      return null;
    }
    return mapping;
  };

  const batch = await buildCardmarketPriceGuideBatch(payload, {
    resolveMapping: guardedResolveMapping,
    observedAt,
    tcgCode,
  });

  const sourceHash = sha256Hex(sourceBytes ?? canonicalJson(payload));
  const acceptedIdentityIds = uniqueSorted(batch.observations.map((row) => row.cardIdentityId));
  const acceptedMappingIds = uniqueSorted(batch.observations.map((row) => row.cardSourceMappingId));
  const pricedIdentityIds = uniqueSorted(batch.observations
    .filter((row) => [row.avgLifetime, row.lowPrice, row.trendPrice, row.avg1d, row.avg7d, row.avg30d]
      .some((value) => value != null && Number(value) > 0))
    .map((row) => row.cardIdentityId));
  const unresolved = batch.rejections.filter((row) => row.rejectionCode === 'identity_unresolved');

  const report = Object.freeze({
    schemaVersion: 1,
    mode: 'review_only_no_database_writes',
    source: Object.freeze({
      label: sourceLabel,
      sourceName: batch.snapshot.sourceName,
      sourceSnapshotId: batch.snapshot.sourceSnapshotId,
      sourceVersion: batch.snapshot.sourceVersion,
      sourceEffectiveAt: new Date(batch.snapshot.sourceEffectiveAt).toISOString(),
      sha256: sourceHash,
    }),
    counts: Object.freeze({
      discoveredSourceRows: batch.snapshot.priceGuides.length,
      evidenceLanesSeen: batch.run.recordsSeen,
      verifiedCanonicalIdentitiesReferenced: acceptedIdentityIds.length,
      exactMappingsReferenced: acceptedMappingIds.length,
      pricedCanonicalIdentitiesPrepared: pricedIdentityIds.length,
      unresolvedEvidenceLanes: unresolved.length,
      quarantinedFinishMappings: quarantinedMappings.length,
      rejectedEvidenceLanes: batch.rejections.length,
      productionVerifiedIdentities: null,
    }),
    validation: Object.freeze({
      writesPerformed: false,
      productionTouched: false,
      missingPricePolicy: 'unknown_not_zero',
      reverseHoloPolicy: 'requires_finish_specific_evidence',
      ambiguousMappingPolicy: 'quarantine',
      exactIdentityRulesChanged: false,
      rejectionReasons: countBy(batch.rejections, (row) => row.rejectionCode),
      quarantineReasons: countBy(quarantinedMappings, (row) => row.reason),
    }),
    exactIdentityReferences: acceptedIdentityIds,
    exactSourceMappingReferences: acceptedMappingIds,
    quarantinedMappings: Object.freeze(quarantinedMappings),
    rejections: batch.rejections,
    observations: batch.observations,
  });

  return Object.freeze({
    report,
    deterministicReportSha256: sha256Hex(canonicalJson(report)),
  });
}
