import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseMarketObservationCandidate } from './market-observation.mjs';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import {
  listVerifiedPriceCapableCardmarketProductIds,
  scopeCardmarketPriceGuideToMappedProducts,
} from './cardmarket-market-cycle.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';

const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-sixrepair-fingerprint-rehearsal.json');

const REPAIRS = Object.freeze([
  { mappingId: 'sixrepair:276425:holo', sourceRecordId: '276425', sourceVariantKey: 'holo', cardIdentityId: 'fdcard_62b14039f556176d932ef9bf' },
  { mappingId: 'sixrepair:278207:normal', sourceRecordId: '278207', sourceVariantKey: 'normal', cardIdentityId: 'fdcard_a3316a52df349f51146513de' },
  { mappingId: 'sixrepair:278364:normal', sourceRecordId: '278364', sourceVariantKey: 'normal', cardIdentityId: 'fdcard_add8d56c588dbccc11089adb' },
  { mappingId: 'sixrepair:278998:holo', sourceRecordId: '278998', sourceVariantKey: 'holo', cardIdentityId: 'fdcard_b1273b872c4a31e07a910f80' },
  { mappingId: 'sixrepair:279180:holo', sourceRecordId: '279180', sourceVariantKey: 'holo', cardIdentityId: 'fdcard_a29e556b7224cbe7db83a5b9' },
  { mappingId: 'sixrepair:281314:normal', sourceRecordId: '281314', sourceVariantKey: 'normal', cardIdentityId: 'fdcard_e682b4505d21bde83111edbf' },
]);

function price(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid stored market price: ${value}`);
  return parsed;
}

function rebuildObservation(row) {
  return normaliseMarketObservationCandidate({
    ingestRunId: row.ingest_run_id,
    cardIdentityId: row.card_identity_id,
    cardSourceMappingId: row.card_source_mapping_id,
    sourceName: row.source_name,
    sourceSnapshotId: row.source_snapshot_id,
    sourceRecordId: row.source_record_id,
    sourceVariantKey: row.source_variant_key,
    marketSegmentKey: row.market_segment_key,
    conditionCode: row.condition_code,
    currencyCode: row.currency_code,
    observedAt: Number(row.observed_at),
    sourceEffectiveAt: row.source_effective_at == null ? null : Number(row.source_effective_at),
    marketPrice: price(row.market_price),
    lowPrice: price(row.low_price),
    trendPrice: price(row.trend_price),
    avg1d: price(row.avg_1d),
    avg7d: price(row.avg_7d),
    avg30d: price(row.avg_30d),
    avgLifetime: price(row.avg_lifetime),
    excellentPlusLow: price(row.excellent_plus_low),
    metricsJson: row.metrics_json || {},
    rawPayload: row.raw_payload || {},
    createdAt: Number(row.created_at),
  });
}

function validateMappingRows(rows) {
  if (rows.length !== REPAIRS.length) throw new Error(`Expected ${REPAIRS.length} six-repair mappings, found ${rows.length}`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const expected of REPAIRS) {
    const row = byId.get(expected.mappingId);
    if (!row) throw new Error(`Missing six-repair mapping ${expected.mappingId}`);
    if (row.source_name !== 'cardmarket'
      || String(row.source_record_id) !== expected.sourceRecordId
      || row.source_variant_key !== expected.sourceVariantKey
      || row.card_identity_id !== expected.cardIdentityId) {
      throw new Error(`Six-repair mapping drifted: ${expected.mappingId}`);
    }
  }
}

async function buildCurrentBatch(pool) {
  const store = { pool: async () => pool };
  const source = await fetchCardmarketPokemonPriceGuide({ fetchedAt: Date.now() });
  const mappedProductIds = await listVerifiedPriceCapableCardmarketProductIds(store);
  const scopedPayload = scopeCardmarketPriceGuideToMappedProducts(source.artifact.payload, mappedProductIds);
  const batch = await prepareCardmarketDailyPriceGuideBatch({
    store,
    priceGuidePayload: scopedPayload,
    observedAt: Date.now(),
    lanes: ['standard','holo'],
  });
  return { source, batch, mappedProductIds, scopedPayload };
}

export async function rehearse(pool) {
  const db = await pool.connect();
  try {
    const mappingIds = REPAIRS.map((row) => row.mappingId);
    const { rows: mappings } = await db.query(`
      SELECT id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version
      FROM fatedrop_card_source_mappings
      WHERE id=ANY($1::text[])
      ORDER BY id`, [mappingIds]);
    validateMappingRows(mappings);

    const { rows: observations } = await db.query(`
      SELECT id,ingest_run_id,card_identity_id,card_source_mapping_id,source_name,source_snapshot_id,
        source_record_id,source_variant_key,market_segment_key,condition_code,currency_code,
        observed_at,source_effective_at,market_day::text AS market_day,market_price,low_price,trend_price,
        avg_1d,avg_7d,avg_30d,avg_lifetime,excellent_plus_low,metrics_json,raw_payload,
        content_fingerprint,created_at
      FROM fatedrop_market_observations
      WHERE card_source_mapping_id=ANY($1::text[])
      ORDER BY source_effective_at,source_record_id,source_variant_key,id`, [mappingIds]);

    const repairByMappingId = new Map(REPAIRS.map((row) => [row.mappingId, row]));
    const plan = [];
    for (const row of observations) {
      const repair = repairByMappingId.get(row.card_source_mapping_id);
      if (!repair) throw new Error(`Unexpected mapping in repair cohort: ${row.card_source_mapping_id}`);
      if (row.card_identity_id !== repair.cardIdentityId
        || String(row.source_record_id) !== repair.sourceRecordId
        || row.source_variant_key !== repair.sourceVariantKey
        || row.source_name !== 'cardmarket') {
        throw new Error(`Observation ownership drifted: ${row.id}`);
      }
      const rebuilt = rebuildObservation(row);
      if (rebuilt.id !== row.id) throw new Error(`Observation deterministic id drifted: ${row.id} -> ${rebuilt.id}`);
      if (rebuilt.marketDay !== row.market_day) throw new Error(`Observation market day drifted: ${row.id}`);
      plan.push({
        observationId: row.id,
        sourceSnapshotId: row.source_snapshot_id,
        sourceRecordId: row.source_record_id,
        sourceVariantKey: row.source_variant_key,
        marketSegmentKey: row.market_segment_key,
        cardIdentityId: row.card_identity_id,
        cardSourceMappingId: row.card_source_mapping_id,
        oldFingerprint: row.content_fingerprint,
        expectedFingerprint: rebuilt.contentFingerprint,
        needsRepair: row.content_fingerprint !== rebuilt.contentFingerprint,
      });
    }

    const stale = plan.filter((row) => row.needsRepair);
    const current = plan.filter((row) => !row.needsRepair);
    const { source, batch, mappedProductIds, scopedPayload } = await buildCurrentBatch(pool);

    await db.query('BEGIN');
    try {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-sixrepair-fingerprint-v1'))`);
      let updated = 0;
      for (const row of stale) {
        const result = await db.query(`
          UPDATE fatedrop_market_observations
          SET content_fingerprint=$1
          WHERE id=$2
            AND content_fingerprint=$3
            AND card_identity_id=$4
            AND card_source_mapping_id=$5
            AND source_name='cardmarket'
            AND source_record_id=$6
            AND source_variant_key=$7`, [
          row.expectedFingerprint,
          row.observationId,
          row.oldFingerprint,
          row.cardIdentityId,
          row.cardSourceMappingId,
          String(row.sourceRecordId),
          row.sourceVariantKey,
        ]);
        if (result.rowCount !== 1) throw new Error(`Fingerprint repair precondition failed: ${row.observationId}`);
        updated += 1;
      }

      const incomingPayload = batch.observations.map((row) => ({ id: row.id, content_fingerprint: row.contentFingerprint }));
      const { rows: [verification] } = await db.query(`
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(id text,content_fingerprint text)
        )
        SELECT
          COUNT(*)::int AS incoming,
          COUNT(o.id)::int AS existing,
          COUNT(*) FILTER (WHERE o.id IS NULL)::int AS missing,
          COUNT(*) FILTER (WHERE o.id IS NOT NULL AND o.content_fingerprint=i.content_fingerprint)::int AS exact_duplicates,
          COUNT(*) FILTER (WHERE o.id IS NOT NULL AND o.content_fingerprint IS DISTINCT FROM i.content_fingerprint)::int AS fingerprint_conflicts
        FROM incoming i
        LEFT JOIN fatedrop_market_observations o ON o.id=i.id`, [JSON.stringify(incomingPayload)]);

      const { rows: [cohortVerification] } = await db.query(`
        SELECT
          COUNT(*)::int AS rows,
          COUNT(*) FILTER (WHERE x.expected_fingerprint=o.content_fingerprint)::int AS exact,
          COUNT(*) FILTER (WHERE x.expected_fingerprint IS DISTINCT FROM o.content_fingerprint)::int AS bad
        FROM fatedrop_market_observations o
        JOIN jsonb_to_recordset($1::jsonb) AS x(observation_id text,expected_fingerprint text)
          ON x.observation_id=o.id`, [JSON.stringify(plan.map((row) => ({
        observation_id: row.observationId,
        expected_fingerprint: row.expectedFingerprint,
      })))]);

      if (Number(cohortVerification.bad) !== 0) throw new Error(`Cohort fingerprint verification failed: ${JSON.stringify(cohortVerification)}`);
      if (Number(verification.fingerprint_conflicts) !== 0) throw new Error(`Daily cycle would still hit immutable conflicts: ${verification.fingerprint_conflicts}`);

      await db.query('ROLLBACK');
      return {
        status: 'rehearsal_passed',
        productionWrites: false,
        guard: 'Only content_fingerprint is changed in rehearsal; card identity, mapping, source evidence, prices, timestamps, and observation ids remain untouched.',
        source: {
          sha256: source.artifact.sha256,
          etag: source.artifact.etag,
          lastModified: source.artifact.lastModified,
          sourceSnapshotId: batch.snapshot.sourceSnapshotId,
          sourceEffectiveAt: batch.snapshot.sourceEffectiveAt,
        },
        counts: {
          repairMappings: mappings.length,
          cohortObservations: plan.length,
          staleFingerprints: stale.length,
          alreadyCanonicalFingerprints: current.length,
          rehearsedFingerprintUpdates: updated,
          mappedProducts: mappedProductIds.size,
          scopedPriceGuideRows: scopedPayload.priceGuides.length,
          incomingObservations: batch.observations.length,
          incomingRejections: batch.rejections.length,
          wouldInsertNewObservations: Number(verification.missing),
          wouldDeduplicateExistingObservations: Number(verification.exact_duplicates),
          remainingImmutableConflicts: Number(verification.fingerprint_conflicts),
        },
        cohortVerification,
        dailyCycleVerification: verification,
        repairPlan: stale,
      };
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch {}
      throw error;
    }
  } finally {
    db.release();
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  let report;
  try {
    report = await rehearse(pool);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
  await writeFile(OUTPUT(), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    error: report.error,
    counts: report.counts,
    cohortVerification: report.cohortVerification,
    dailyCycleVerification: report.dailyCycleVerification,
    repairPlan: report.repairPlan?.map((row) => ({
      observationId: row.observationId,
      sourceSnapshotId: row.sourceSnapshotId,
      sourceRecordId: row.sourceRecordId,
      sourceVariantKey: row.sourceVariantKey,
      marketSegmentKey: row.marketSegmentKey,
      cardIdentityId: row.cardIdentityId,
      cardSourceMappingId: row.cardSourceMappingId,
    })),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
