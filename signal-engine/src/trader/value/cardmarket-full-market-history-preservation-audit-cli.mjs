import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

const INPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-recertification.json');
const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-history-preservation-audit.json');

const sourceKey = (recordId, variantKey) => `${String(recordId)}::${String(variantKey)}`;

export async function auditHistoryPreservation(db, report) {
  if (report?.status !== 'audit_complete' || report?.productionWrites !== false) {
    throw new Error('Completed read-only recertification plan required');
  }

  const certified = Array.isArray(report.certified) ? report.certified : [];
  const planBySourceKey = new Map();
  for (const row of certified) {
    const key = sourceKey(row.sourceRecordId, row.sourceVariantKey);
    if (planBySourceKey.has(key)) throw new Error(`Duplicate certified Cardmarket source key: ${key}`);
    planBySourceKey.set(key, row);
  }

  const stale = [];
  for (const target of certified.filter((row) => row.action === 'replace')) {
    for (const mapping of target.currentMappings || []) {
      const exact = String(mapping.sourceRecordId) === String(target.sourceRecordId)
        && String(mapping.sourceVariantKey) === String(target.sourceVariantKey);
      if (exact) continue;
      stale.push({
        mappingId: mapping.id,
        currentCardIdentityId: target.cardIdentityId,
        sourceRecordId: String(mapping.sourceRecordId),
        sourceVariantKey: String(mapping.sourceVariantKey),
        targetCardIdentityId: target.cardIdentityId,
        targetSourceRecordId: String(target.sourceRecordId),
        targetSourceVariantKey: String(target.sourceVariantKey),
      });
    }
  }

  const staleIds = stale.map((row) => row.mappingId);
  const { rows: liveRows } = staleIds.length ? await db.query(`
    SELECT
      m.id,
      m.card_identity_id,
      m.source_record_id,
      m.source_variant_key,
      COUNT(o.id)::int AS observation_count
    FROM fatedrop_card_source_mappings m
    LEFT JOIN fatedrop_market_observations o ON o.card_source_mapping_id=m.id
    WHERE m.id = ANY($1::text[])
    GROUP BY m.id,m.card_identity_id,m.source_record_id,m.source_variant_key
    ORDER BY m.id`, [staleIds]) : { rows: [] };

  const liveById = new Map(liveRows.map((row) => [row.id, row]));
  const missingMappings = [];
  const driftedMappings = [];
  const rehomeableClaimedRows = [];
  const safeZeroObservationDeletes = [];
  const blockedUnclaimedHistoryRows = [];

  for (const row of stale) {
    const live = liveById.get(row.mappingId);
    if (!live) {
      missingMappings.push(row);
      continue;
    }
    if (String(live.card_identity_id) !== String(row.currentCardIdentityId)
      || String(live.source_record_id) !== String(row.sourceRecordId)
      || String(live.source_variant_key) !== String(row.sourceVariantKey)) {
      driftedMappings.push({ ...row, live });
      continue;
    }

    const observations = Number(live.observation_count || 0);
    const claimedOwner = planBySourceKey.get(sourceKey(row.sourceRecordId, row.sourceVariantKey));
    const enriched = {
      ...row,
      observationCount: observations,
      certifiedOwnerCardIdentityId: claimedOwner?.cardIdentityId || null,
      certifiedOwnerSourceRecordId: claimedOwner ? String(claimedOwner.sourceRecordId) : null,
      certifiedOwnerSourceVariantKey: claimedOwner ? String(claimedOwner.sourceVariantKey) : null,
    };

    if (claimedOwner) {
      rehomeableClaimedRows.push(enriched);
    } else if (observations === 0) {
      safeZeroObservationDeletes.push(enriched);
    } else {
      blockedUnclaimedHistoryRows.push(enriched);
    }
  }

  const sumObservations = (rows) => rows.reduce((sum, row) => sum + Number(row.observationCount || 0), 0);
  const blockedTargetIdentityIds = [...new Set(blockedUnclaimedHistoryRows.map((row) => row.targetCardIdentityId))].sort();
  const claimedObservationRows = sumObservations(rehomeableClaimedRows);
  const blockedObservationRows = sumObservations(blockedUnclaimedHistoryRows);
  const allStaleObservationRows = claimedObservationRows + blockedObservationRows;

  return {
    status: missingMappings.length || driftedMappings.length ? 'precondition_drifted' : 'audit_complete',
    productionWrites: false,
    programme: 'cardmarket_full_market_history_preservation_audit_v1',
    sourceCertifiedDigest: report.certifiedDigest,
    counts: {
      certified: certified.length,
      replacementTargets: certified.filter((row) => row.action === 'replace').length,
      staleMappingRows: stale.length,
      liveStaleMappingRows: liveRows.length,
      rehomeableClaimedRows: rehomeableClaimedRows.length,
      rehomeableClaimedObservationRows: claimedObservationRows,
      safeZeroObservationDeletes: safeZeroObservationDeletes.length,
      blockedUnclaimedHistoryRows: blockedUnclaimedHistoryRows.length,
      blockedUnclaimedObservationRows: blockedObservationRows,
      allStaleObservationRows,
      blockedTargetIdentities: blockedTargetIdentityIds.length,
      missingMappings: missingMappings.length,
      driftedMappings: driftedMappings.length,
    },
    decision: {
      historySafeReleaseReady: missingMappings.length === 0
        && driftedMappings.length === 0
        && blockedUnclaimedHistoryRows.length === 0,
      requiredGuard: 'Never delete fatedrop_market_observations during Cardmarket recertification.',
      claimedRows: 'May be re-homed in place to their independently certified source-key owner while preserving mapping IDs and observation IDs.',
      zeroObservationRows: 'May be retired without historical data loss.',
      blockedRows: 'Must remain quarantined until their source key has an independently certified owner; never guess or delete their observations.',
    },
    blockedTargetIdentityIds,
    rehomeableClaimedRows,
    safeZeroObservationDeletes,
    blockedUnclaimedHistoryRows,
    missingMappings,
    driftedMappings,
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const report = JSON.parse(await readFile(INPUT(), 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let result;
  try {
    result = await auditHistoryPreservation(db, report);
    if (result.status !== 'audit_complete') process.exitCode = 1;
  } catch (error) {
    result = {
      status: 'blocked',
      productionWrites: false,
      error: error instanceof Error ? error.message : String(error),
    };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(OUTPUT(), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.counts || result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
