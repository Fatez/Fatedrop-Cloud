import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import {
  REVIEWED_BASELINE_HOLO_PRODUCT_IDS,
  REVIEWED_STALE_VARIANT_PLAN_DIGEST,
  REVIEWED_STALE_VARIANT_RETIREMENTS,
  REVIEWED_STALE_VARIANT_TCGDEX_REVISION,
  reviewedStaleVariantPlanDigest,
  validateReviewedStaleVariantPlan,
} from './cardmarket-reviewed-stale-variant-retirement.mjs';

const sameStamp = (variant, expected) => {
  const actual = [...(variant?.stamp || [])].map(String).sort();
  const wanted = expected ? expected.split(',').filter(Boolean).sort() : [];
  return JSON.stringify(actual) === JSON.stringify(wanted);
};
const baselineHolo = (variant) => variant?.type === 'holo'
  && (variant.subtype == null || variant.subtype === '')
  && (variant.foil == null || variant.foil === '')
  && Array.isArray(variant.stamp)
  && variant.stamp.length === 0;

async function build(db) {
  if (!validateReviewedStaleVariantPlan()) throw new Error('Frozen reviewed stale-variant plan integrity failed');
  if (reviewedStaleVariantPlanDigest() !== REVIEWED_STALE_VARIANT_PLAN_DIGEST) throw new Error('Frozen reviewed stale-variant plan digest drifted');
  if (process.env.TCGDEX_REVISION !== REVIEWED_STALE_VARIANT_TCGDEX_REVISION) throw new Error(`TCGdex revision must equal ${REVIEWED_STALE_VARIANT_TCGDEX_REVISION}`);

  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const mappingIds = [...new Set(REVIEWED_STALE_VARIANT_RETIREMENTS.flatMap((row) => [row.mappingId, row.retainedMappingId]))];
  const productIds = [...new Set(REVIEWED_STALE_VARIANT_RETIREMENTS.flatMap((row) => [row.sourceRecordId, row.retainedProductId]))];
  const { rows: currentMappings } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
      AND (id=ANY($1::text[]) OR source_record_id=ANY($2::text[]))
    ORDER BY source_record_id,source_variant_key,id`, [mappingIds, productIds]);
  const byId = new Map(currentMappings.map((row) => [row.id, row]));
  const byProduct = new Map();
  for (const row of currentMappings) {
    const key = String(row.source_record_id);
    const list = byProduct.get(key) || [];
    list.push(row);
    byProduct.set(key, list);
  }

  const evidence = [];
  for (const planned of REVIEWED_STALE_VARIANT_RETIREMENTS) {
    const stale = byId.get(planned.mappingId);
    if (!stale
      || stale.card_identity_id !== planned.cardIdentityId
      || String(stale.source_record_id) !== planned.sourceRecordId
      || stale.source_variant_key !== planned.sourceVariantKey) {
      throw new Error(`Stale mapping drifted: ${planned.mappingId}`);
    }
    const retained = byId.get(planned.retainedMappingId);
    if (!retained
      || String(retained.source_record_id) !== planned.retainedProductId
      || retained.source_variant_key !== 'holo') {
      throw new Error(`Retained holo mapping drifted: ${planned.retainedMappingId}`);
    }
    if (planned.kind === 'stamped_holo' && retained.card_identity_id !== planned.cardIdentityId) {
      throw new Error(`Baseline holo owner drifted for ${planned.retainedProductId}`);
    }
    if (planned.kind === 'competing_normal' && retained.card_identity_id === planned.cardIdentityId) {
      throw new Error(`Competing normal no longer belongs to a distinct standard identity: ${planned.mappingId}`);
    }

    const card = cardById.get(planned.tcgdexCardId);
    if (!card) throw new Error(`Pinned TCGdex card missing: ${planned.tcgdexCardId}`);
    const retainedVariants = (card.variants || []).filter((variant) => String(variant.cardmarketProductId || '') === planned.retainedProductId);
    if (retainedVariants.length !== 1 || !baselineHolo(retainedVariants[0])) {
      throw new Error(`Retained product is not the single unstamped baseline holo in pinned TCGdex: ${planned.retainedProductId}`);
    }

    if (planned.kind === 'stamped_holo') {
      const staleVariants = (card.variants || []).filter((variant) => String(variant.cardmarketProductId || '') === planned.sourceRecordId);
      if (staleVariants.length !== 1 || staleVariants[0].type !== 'holo' || !sameStamp(staleVariants[0], planned.stamp) || !(staleVariants[0].stamp || []).length) {
        throw new Error(`Stamped product evidence drifted: ${planned.sourceRecordId}`);
      }
      const staleOwners = byProduct.get(planned.sourceRecordId) || [];
      if (staleOwners.length !== 1 || staleOwners[0].id !== planned.mappingId) {
        throw new Error(`Stamped product ownership drifted: ${planned.sourceRecordId}`);
      }
    } else if (planned.kind === 'competing_normal') {
      const normalExplicit = (card.variants || []).filter((variant) => variant?.type === 'normal' && String(variant.cardmarketProductId || '') === planned.sourceRecordId);
      if (normalExplicit.length !== 0) throw new Error(`Pinned TCGdex explicitly supports competing normal mapping: ${planned.sourceRecordId}`);
      const owners = byProduct.get(planned.sourceRecordId) || [];
      const ownerIds = new Set(owners.map((row) => row.id));
      if (owners.length !== 2 || !ownerIds.has(planned.mappingId) || !ownerIds.has(planned.retainedMappingId)) {
        throw new Error(`Competing normal ownership drifted: ${planned.sourceRecordId}`);
      }
    } else {
      throw new Error(`Unknown reviewed retirement kind: ${planned.kind}`);
    }

    evidence.push({ ...planned, retainedCardIdentityId: retained.card_identity_id });
  }

  for (const productId of REVIEWED_BASELINE_HOLO_PRODUCT_IDS) {
    const owners = byProduct.get(productId) || [];
    if (owners.length !== 1 || owners[0].source_variant_key !== 'holo') {
      throw new Error(`Reviewed baseline product does not have exactly one holo owner: ${productId}`);
    }
  }

  const observationKeys = evidence.map((row) => ({
    card_identity_id: row.cardIdentityId,
    source_record_id: row.sourceRecordId,
    source_variant_key: row.sourceVariantKey,
  }));
  const { rows: observationRows } = await db.query(`
    WITH c AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS x(card_identity_id text,source_record_id text,source_variant_key text)
    )
    SELECT COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0)) > 0)::int AS positive_count
    FROM fatedrop_market_observations o
    JOIN c ON c.card_identity_id=o.card_identity_id
          AND c.source_record_id=o.source_record_id
          AND c.source_variant_key=o.source_variant_key
    WHERE o.source_name='cardmarket'`, [JSON.stringify(observationKeys)]);

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: { tcgdexRevision: REVIEWED_STALE_VARIANT_TCGDEX_REVISION },
    plan: {
      digest: REVIEWED_STALE_VARIANT_PLAN_DIGEST,
      retirementRows: evidence.length,
      stampedHoloRows: evidence.filter((row) => row.kind === 'stamped_holo').length,
      competingNormalRows: evidence.filter((row) => row.kind === 'competing_normal').length,
      baselineProducts: REVIEWED_BASELINE_HOLO_PRODUCT_IDS.length,
    },
    observations: {
      rowsToDelete: Number(observationRows[0]?.count || 0),
      positiveRowsToDelete: Number(observationRows[0]?.positive_count || 0),
    },
    retirements: evidence,
  };
}

async function persist(db, report) {
  let retiredMappings = 0;
  let deletedObservations = 0;
  await db.query('BEGIN');
  try {
    for (const row of report.retirements) {
      const stale = await db.query(`
        SELECT id,card_identity_id,source_record_id,source_variant_key
        FROM fatedrop_card_source_mappings
        WHERE id=$1 AND card_identity_id=$2 AND source_name='cardmarket'
          AND source_record_id=$3 AND source_variant_key=$4
        FOR UPDATE`, [row.mappingId, row.cardIdentityId, row.sourceRecordId, row.sourceVariantKey]);
      if (stale.rowCount !== 1) throw new Error(`Stale mapping changed before write: ${row.mappingId}`);

      const retained = await db.query(`
        SELECT id,card_identity_id,source_record_id,source_variant_key
        FROM fatedrop_card_source_mappings
        WHERE id=$1 AND source_name='cardmarket' AND source_record_id=$2 AND source_variant_key='holo'
        FOR UPDATE`, [row.retainedMappingId, row.retainedProductId]);
      if (retained.rowCount !== 1) throw new Error(`Retained mapping changed before write: ${row.retainedMappingId}`);
      if (row.kind === 'stamped_holo' && retained.rows[0].card_identity_id !== row.cardIdentityId) {
        throw new Error(`Retained identity changed before write: ${row.retainedMappingId}`);
      }
      if (row.kind === 'competing_normal' && retained.rows[0].card_identity_id === row.cardIdentityId) {
        throw new Error(`Competing normal relationship changed before write: ${row.mappingId}`);
      }

      const removedObs = await db.query(`
        DELETE FROM fatedrop_market_observations
        WHERE card_identity_id=$1 AND source_name='cardmarket'
          AND source_record_id=$2 AND source_variant_key=$3`, [row.cardIdentityId, row.sourceRecordId, row.sourceVariantKey]);
      deletedObservations += removedObs.rowCount || 0;

      const removed = await db.query(`
        DELETE FROM fatedrop_card_source_mappings
        WHERE id=$1 AND card_identity_id=$2 AND source_name='cardmarket'
          AND source_record_id=$3 AND source_variant_key=$4`, [row.mappingId, row.cardIdentityId, row.sourceRecordId, row.sourceVariantKey]);
      if (removed.rowCount !== 1) throw new Error(`Failed to retire reviewed mapping: ${row.mappingId}`);
      retiredMappings += 1;
    }

    const ids = report.retirements.map((row) => row.mappingId);
    const { rows: [remaining] } = await db.query(`SELECT COUNT(*)::int AS count FROM fatedrop_card_source_mappings WHERE id=ANY($1::text[])`, [ids]);
    if (Number(remaining?.count || 0) !== 0) throw new Error('One or more reviewed stale mappings survived the transaction');

    for (const productId of REVIEWED_BASELINE_HOLO_PRODUCT_IDS) {
      const retained = await db.query(`SELECT id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 FOR UPDATE`, [productId]);
      if (retained.rowCount !== 1 || retained.rows[0].source_variant_key !== 'holo') {
        throw new Error(`Baseline product ownership invalid after correction: ${productId}`);
      }
    }
    await db.query('COMMIT');
    return { retiredMappings, deletedObservations };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
    if (process.env.CORRECTION_WRITE === 'true') {
      const persistence = await persist(db, report);
      report = { ...report, status: 'write_complete', productionWrites: true, persistence };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-reviewed-stale-variant-retirement.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, plan: report.plan, observations: report.observations, persistence: report.persistence }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
