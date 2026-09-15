import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import {
  listVerifiedPriceCapableCardmarketProductIds,
  scopeCardmarketPriceGuideToMappedProducts,
} from './cardmarket-market-cycle.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';

const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-immutable-observation-audit.json');

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalJson(value));
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function comparableExisting(row) {
  return {
    cardIdentityId: row.card_identity_id,
    cardSourceMappingId: row.card_source_mapping_id,
    sourceName: row.source_name,
    sourceSnapshotId: row.source_snapshot_id,
    sourceRecordId: row.source_record_id,
    sourceVariantKey: row.source_variant_key,
    marketSegmentKey: row.market_segment_key,
    conditionCode: row.condition_code,
    currencyCode: row.currency_code,
    sourceEffectiveAt: row.source_effective_at == null ? null : Number(row.source_effective_at),
    marketDay: row.market_day == null ? null : String(row.market_day).slice(0, 10),
    prices: {
      marketPrice: numberOrNull(row.market_price),
      lowPrice: numberOrNull(row.low_price),
      trendPrice: numberOrNull(row.trend_price),
      avg1d: numberOrNull(row.avg_1d),
      avg7d: numberOrNull(row.avg_7d),
      avg30d: numberOrNull(row.avg_30d),
      avgLifetime: numberOrNull(row.avg_lifetime),
      excellentPlusLow: numberOrNull(row.excellent_plus_low),
    },
    metricsJson: row.metrics_json || {},
    rawPayload: row.raw_payload || {},
  };
}

function comparableIncoming(row) {
  return {
    cardIdentityId: row.cardIdentityId,
    cardSourceMappingId: row.cardSourceMappingId,
    sourceName: row.sourceName,
    sourceSnapshotId: row.sourceSnapshotId,
    sourceRecordId: row.sourceRecordId,
    sourceVariantKey: row.sourceVariantKey,
    marketSegmentKey: row.marketSegmentKey,
    conditionCode: row.conditionCode,
    currencyCode: row.currencyCode,
    sourceEffectiveAt: row.sourceEffectiveAt == null ? null : Number(row.sourceEffectiveAt),
    marketDay: row.marketDay,
    prices: {
      marketPrice: numberOrNull(row.marketPrice),
      lowPrice: numberOrNull(row.lowPrice),
      trendPrice: numberOrNull(row.trendPrice),
      avg1d: numberOrNull(row.avg1d),
      avg7d: numberOrNull(row.avg7d),
      avg30d: numberOrNull(row.avg30d),
      avgLifetime: numberOrNull(row.avgLifetime),
      excellentPlusLow: numberOrNull(row.excellentPlusLow),
    },
    metricsJson: row.metricsJson || {},
    rawPayload: row.rawPayload || {},
  };
}

function diffObject(left, right) {
  const fields = [
    'cardIdentityId','cardSourceMappingId','sourceName','sourceSnapshotId','sourceRecordId','sourceVariantKey',
    'marketSegmentKey','conditionCode','currencyCode','sourceEffectiveAt','marketDay','prices','metricsJson','rawPayload',
  ];
  return fields.filter((field) => stableJson(left[field]) !== stableJson(right[field]));
}

function sourceEvidenceOnly(value) {
  const { cardIdentityId: _ci, cardSourceMappingId: _cm, ...rest } = value;
  return rest;
}

async function loadIdentityDetails(db, identityIds) {
  if (!identityIds.length) return new Map();
  const { rows } = await db.query(`
    SELECT i.id AS card_identity_id,i.variant_code,i.language_code,p.name,p.collector_number,
      s.code AS set_code,s.name AS set_name
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=p.set_id
    WHERE i.id=ANY($1::text[])`, [identityIds]);
  return new Map(rows.map((row) => [row.card_identity_id, row]));
}

export async function audit(db, { fetchedAt = Date.now(), observedAt = fetchedAt } = {}) {
  const store = { pool: async () => db.pool || db };
  const source = await fetchCardmarketPokemonPriceGuide({ fetchedAt });
  const mappedProductIds = await listVerifiedPriceCapableCardmarketProductIds(store);
  const scopedPayload = scopeCardmarketPriceGuideToMappedProducts(source.artifact.payload, mappedProductIds);
  const batch = await prepareCardmarketDailyPriceGuideBatch({
    store,
    priceGuidePayload: scopedPayload,
    observedAt,
    lanes: ['standard','holo'],
  });

  const { rows: existingRows } = await db.query(`
    SELECT id,ingest_run_id,card_identity_id,card_source_mapping_id,source_name,source_snapshot_id,
      source_record_id,source_variant_key,market_segment_key,condition_code,currency_code,
      observed_at,source_effective_at,market_day,market_price,low_price,trend_price,avg_1d,avg_7d,avg_30d,
      avg_lifetime,excellent_plus_low,metrics_json,raw_payload,content_fingerprint,created_at
    FROM fatedrop_market_observations
    WHERE source_name='cardmarket' AND source_snapshot_id=$1`, [batch.snapshot.sourceSnapshotId]);
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  const conflicts = [];
  for (const incoming of batch.observations) {
    const existing = existingById.get(incoming.id);
    if (!existing || existing.content_fingerprint === incoming.contentFingerprint) continue;
    const oldValue = comparableExisting(existing);
    const newValue = comparableIncoming(incoming);
    const differences = diffObject(oldValue, newValue);
    const sourceEvidenceUnchanged = stableJson(sourceEvidenceOnly(oldValue)) === stableJson(sourceEvidenceOnly(newValue));
    conflicts.push({
      observationId: incoming.id,
      sourceSnapshotId: incoming.sourceSnapshotId,
      sourceRecordId: incoming.sourceRecordId,
      sourceVariantKey: incoming.sourceVariantKey,
      marketSegmentKey: incoming.marketSegmentKey,
      existingContentFingerprint: existing.content_fingerprint,
      incomingContentFingerprint: incoming.contentFingerprint,
      differences,
      classification: sourceEvidenceUnchanged
        ? 'OWNERSHIP_ONLY_REHOME_CANDIDATE'
        : 'SOURCE_EVIDENCE_CHANGED_WITHIN_SAME_SNAPSHOT_ID',
      sourceEvidenceUnchanged,
      existing: oldValue,
      incoming: newValue,
    });
  }

  const identityIds = [...new Set(conflicts.flatMap((row) => [row.existing.cardIdentityId, row.incoming.cardIdentityId]).filter(Boolean))];
  const identityDetails = await loadIdentityDetails(db, identityIds);
  for (const conflict of conflicts) {
    conflict.existingIdentity = identityDetails.get(conflict.existing.cardIdentityId) || null;
    conflict.incomingIdentity = identityDetails.get(conflict.incoming.cardIdentityId) || null;
  }

  const mappingIds = [...new Set(conflicts.flatMap((row) => [row.existing.cardSourceMappingId, row.incoming.cardSourceMappingId]).filter(Boolean))];
  const { rows: mappings } = mappingIds.length ? await db.query(`
    SELECT id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version
    FROM fatedrop_card_source_mappings
    WHERE id=ANY($1::text[])
    ORDER BY id`, [mappingIds]) : { rows: [] };
  const mappingById = new Map(mappings.map((row) => [row.id, row]));
  for (const conflict of conflicts) {
    conflict.existingMappingCurrent = mappingById.get(conflict.existing.cardSourceMappingId) || null;
    conflict.incomingMappingCurrent = mappingById.get(conflict.incoming.cardSourceMappingId) || null;
  }

  const ownershipOnly = conflicts.filter((row) => row.classification === 'OWNERSHIP_ONLY_REHOME_CANDIDATE');
  const evidenceChanged = conflicts.filter((row) => row.classification === 'SOURCE_EVIDENCE_CHANGED_WITHIN_SAME_SNAPSHOT_ID');

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      url: source.artifact.url,
      sha256: source.artifact.sha256,
      etag: source.artifact.etag,
      lastModified: source.artifact.lastModified,
      fetchedAt: source.artifact.fetchedAt,
      sourceSnapshotId: batch.snapshot.sourceSnapshotId,
      sourceEffectiveAt: batch.snapshot.sourceEffectiveAt,
    },
    counts: {
      mappedProducts: mappedProductIds.size,
      scopedPriceGuideRows: scopedPayload.priceGuides.length,
      incomingObservations: batch.observations.length,
      incomingRejections: batch.rejections.length,
      existingSnapshotObservations: existingRows.length,
      fingerprintConflicts: conflicts.length,
      ownershipOnlyRehomeCandidates: ownershipOnly.length,
      sourceEvidenceChangedConflicts: evidenceChanged.length,
    },
    conflicts,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  db.pool = pool;
  let report;
  try {
    report = await audit(db);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(OUTPUT(), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    error: report.error,
    source: report.source,
    counts: report.counts,
    conflicts: report.conflicts?.map((row) => ({
      observationId: row.observationId,
      sourceRecordId: row.sourceRecordId,
      sourceVariantKey: row.sourceVariantKey,
      marketSegmentKey: row.marketSegmentKey,
      classification: row.classification,
      differences: row.differences,
      existingIdentity: row.existingIdentity,
      incomingIdentity: row.incomingIdentity,
      existingMappingId: row.existing.cardSourceMappingId,
      incomingMappingId: row.incoming.cardSourceMappingId,
    })),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
