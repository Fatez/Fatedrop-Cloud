import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import {
  ROOT_FINISH_POLICY,
  assessBaselineFinishEvidence,
  getRootCardmarketProductId,
  rootProductNameMatches,
} from './cardmarket-tcgdex-root-evidence.mjs';

const key = (...parts) => parts.join('|');

async function build(db) {
  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows } = await db.query(`
    SELECT i.id, i.variant_code, p.name, p.collector_number,
           cm.id AS current_mapping_id,
           cm.source_record_id AS current_cardmarket_id,
           cm.source_variant_key,
           array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    JOIN fatedrop_card_source_mappings cm
      ON cm.card_identity_id=i.id
     AND cm.source_name='cardmarket'
     AND cm.source_variant_key=CASE WHEN i.variant_code='standard' THEN 'normal' ELSE 'holo' END
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
    GROUP BY i.id,i.variant_code,p.name,p.collector_number,cm.id,cm.source_record_id,cm.source_variant_key
    ORDER BY i.id,cm.id`);

  const { rows: allMappings } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const ownerBySource = new Map(allMappings.map((row) => [key(row.source_record_id, row.source_variant_key), row.card_identity_id]));

  const counts = {
    mappedTargetRows: rows.length,
    withRootProductId: 0,
    rootEvidenceValid: 0,
    agreesWithRoot: 0,
    disagreesWithRoot: 0,
    desiredSourceOwnedByOtherIdentity: 0,
    rawCorrectionRows: 0,
    safeCorrectionGroups: 0,
    safeUpdateGroups: 0,
    safeRetireOnlyGroups: 0,
    staleMappingRowsToRetire: 0,
    batchConflictKeys: 0,
    batchHeldRows: 0,
    invalidObservations: 0,
  };
  const reasons = {};
  const raw = [];
  const reason = (name) => { reasons[name] = (reasons[name] || 0) + 1; };

  for (const row of rows) {
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      reason('multiple_tcgdex_card_links');
      continue;
    }
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    if (!card) { reason('missing_tcgdex_card'); continue; }

    const rootProductId = getRootCardmarketProductId(card);
    if (!rootProductId) { reason('no_root_cardmarket_product_id'); continue; }
    counts.withRootProductId += 1;
    const desiredSourceRecordId = String(rootProductId);
    const product = productById.get(desiredSourceRecordId);
    if (!product) { reason('root_product_absent_from_official_catalogue'); continue; }
    if (!rootProductNameMatches(row.name, product.name)) { reason('root_product_name_conflict'); continue; }

    const finishEvidence = assessBaselineFinishEvidence(card, row.variant_code, rootProductId);
    if (!finishEvidence.ok) { reason(finishEvidence.reason); continue; }
    const policy = ROOT_FINISH_POLICY[row.variant_code];
    const priceRow = priceById.get(desiredSourceRecordId);
    if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, policy.priceLane)) {
      reason('no_meaningful_price_lane');
      continue;
    }
    counts.rootEvidenceValid += 1;

    const currentSourceRecordId = String(row.current_cardmarket_id);
    if (currentSourceRecordId === desiredSourceRecordId) {
      counts.agreesWithRoot += 1;
      continue;
    }
    counts.disagreesWithRoot += 1;

    const desiredKey = key(desiredSourceRecordId, policy.sourceVariantKey);
    const desiredOwner = ownerBySource.get(desiredKey);
    if (desiredOwner && desiredOwner !== row.id) {
      counts.desiredSourceOwnedByOtherIdentity += 1;
      reason('desired_source_owned_by_other_identity');
      continue;
    }

    raw.push({
      cardIdentityId: row.id,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
      tcgdexCardId,
      currentMappingId: row.current_mapping_id,
      currentSourceRecordId,
      desiredSourceRecordId,
      sourceVariantKey: policy.sourceVariantKey,
      desiredProductName: product.name,
      sourceVersion: catalogue.sha256,
      desiredAlreadyMappedToSameIdentity: desiredOwner === row.id,
      proof: {
        method: 'tcgdex_root_product_plus_explicit_baseline_finish',
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        baselineCount: finishEvidence.baselineCount,
        explicitBaselineProductIds: finishEvidence.explicitProductIds,
      },
    });
  }
  counts.rawCorrectionRows = raw.length;

  const byDesiredKey = new Map();
  for (const row of raw) {
    const desiredKey = key(row.desiredSourceRecordId, row.sourceVariantKey);
    const list = byDesiredKey.get(desiredKey) || [];
    list.push(row);
    byDesiredKey.set(desiredKey, list);
  }

  const groups = [];
  for (const [desiredKey, entries] of byDesiredKey) {
    const identities = [...new Set(entries.map((entry) => entry.cardIdentityId))];
    if (identities.length !== 1) {
      counts.batchConflictKeys += 1;
      counts.batchHeldRows += entries.length;
      reason('batch_source_collision');
      continue;
    }
    const cardIdentityId = identities[0];
    const sorted = [...entries].sort((left, right) => left.currentMappingId.localeCompare(right.currentMappingId));
    const desiredAlreadyExists = sorted.some((entry) => entry.desiredAlreadyMappedToSameIdentity);
    const mode = desiredAlreadyExists ? 'retire_stale_only' : 'update_one_then_retire_extras';
    const primaryMappingId = mode === 'update_one_then_retire_extras' ? sorted[0].currentMappingId : null;
    groups.push({
      desiredKey,
      cardIdentityId,
      desiredSourceRecordId: sorted[0].desiredSourceRecordId,
      sourceVariantKey: sorted[0].sourceVariantKey,
      sourceVersion: sorted[0].sourceVersion,
      variantCode: sorted[0].variantCode,
      mode,
      primaryMappingId,
      staleMappings: sorted.map((entry) => ({ id: entry.currentMappingId, sourceRecordId: entry.currentSourceRecordId })),
      proof: sorted[0].proof,
    });
    counts.safeCorrectionGroups += 1;
    if (mode === 'retire_stale_only') counts.safeRetireOnlyGroups += 1;
    else counts.safeUpdateGroups += 1;
    counts.staleMappingRowsToRetire += mode === 'retire_stale_only' ? sorted.length : Math.max(0, sorted.length - 1);
  }

  const observationKeys = groups.flatMap((group) => group.staleMappings.map((mapping) => ({
    card_identity_id: group.cardIdentityId,
    current_source_record_id: mapping.sourceRecordId,
    source_variant_key: group.sourceVariantKey,
  })));
  if (observationKeys.length) {
    const { rows: [observationCount] } = await db.query(`
      WITH c AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x(card_identity_id text,current_source_record_id text,source_variant_key text)
      )
      SELECT COUNT(*)::int AS count
      FROM fatedrop_market_observations o
      JOIN c
        ON c.card_identity_id=o.card_identity_id
       AND c.current_source_record_id=o.source_record_id
       AND c.source_variant_key=o.source_variant_key
      WHERE o.source_name='cardmarket'`, [JSON.stringify(observationKeys)]);
    counts.invalidObservations = Number(observationCount?.count || 0);
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
    },
    policy: {
      rootIdAloneNeverProvesFinish: true,
      exactBaselineFinishRequired: true,
      reverseExcluded: true,
      desiredOwnedByOtherIdentityHeld: true,
      sameIdentityDesiredMappingRetiresOnlyRootProvenStaleRows: true,
      observationsRemovedOnlyForExactStaleIdentityProductFinish: true,
    },
    counts,
    reasons,
    groups,
  };
}

async function persist(db, report) {
  let updatedMappings = 0;
  let retiredMappings = 0;
  let deletedObservations = 0;
  await db.query('BEGIN');
  try {
    for (const group of report.groups) {
      const locked = [];
      for (const stale of group.staleMappings) {
        const current = await db.query(`
          SELECT id,source_record_id
          FROM fatedrop_card_source_mappings
          WHERE id=$1 AND card_identity_id=$2 AND source_name='cardmarket' AND source_variant_key=$3
          FOR UPDATE`, [stale.id, group.cardIdentityId, group.sourceVariantKey]);
        if (current.rowCount !== 1 || String(current.rows[0].source_record_id) !== stale.sourceRecordId) {
          throw new Error(`Current mapping changed for ${group.cardIdentityId}/${stale.id}`);
        }
        locked.push(stale);
      }

      const desired = await db.query(`
        SELECT id,card_identity_id
        FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2
        FOR UPDATE`, [group.desiredSourceRecordId, group.sourceVariantKey]);
      if (desired.rows.some((row) => row.card_identity_id !== group.cardIdentityId)) {
        throw new Error(`Desired source became owned by another identity: ${group.desiredKey}`);
      }
      const desiredExistsForSameIdentity = desired.rows.some((row) => row.card_identity_id === group.cardIdentityId);
      if (group.mode === 'retire_stale_only' && !desiredExistsForSameIdentity) {
        throw new Error(`Expected desired same-identity mapping disappeared: ${group.desiredKey}`);
      }
      if (group.mode === 'update_one_then_retire_extras' && desiredExistsForSameIdentity) {
        throw new Error(`Desired mapping appeared after audit: ${group.desiredKey}`);
      }

      for (const stale of locked) {
        const removed = await db.query(`
          DELETE FROM fatedrop_market_observations
          WHERE card_identity_id=$1 AND source_name='cardmarket' AND source_record_id=$2 AND source_variant_key=$3`,
        [group.cardIdentityId, stale.sourceRecordId, group.sourceVariantKey]);
        deletedObservations += removed.rowCount || 0;
      }

      if (group.mode === 'update_one_then_retire_extras') {
        const primary = locked.find((row) => row.id === group.primaryMappingId);
        if (!primary) throw new Error(`Primary mapping missing from locked group: ${group.primaryMappingId}`);
        const updated = await db.query(`
          UPDATE fatedrop_card_source_mappings
          SET source_record_id=$1, source_version=$2, last_observed_at=$3
          WHERE id=$4 AND card_identity_id=$5 AND source_record_id=$6 AND source_variant_key=$7`,
        [group.desiredSourceRecordId, group.sourceVersion, Date.now(), primary.id, group.cardIdentityId, primary.sourceRecordId, group.sourceVariantKey]);
        if (updated.rowCount !== 1) throw new Error(`Failed to update primary mapping ${primary.id}`);
        updatedMappings += 1;
      }

      for (const stale of locked) {
        if (group.mode === 'update_one_then_retire_extras' && stale.id === group.primaryMappingId) continue;
        const removed = await db.query(`
          DELETE FROM fatedrop_card_source_mappings
          WHERE id=$1 AND card_identity_id=$2 AND source_name='cardmarket' AND source_record_id=$3 AND source_variant_key=$4`,
        [stale.id, group.cardIdentityId, stale.sourceRecordId, group.sourceVariantKey]);
        if (removed.rowCount !== 1) throw new Error(`Failed to retire stale mapping ${stale.id}`);
        retiredMappings += 1;
      }
    }
    await db.query('COMMIT');
    return { updatedMappings, retiredMappings, deletedObservations };
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
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-tcgdex-root-mapping-correction-v2.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, counts: report.counts, reasons: report.reasons, persistence: report.persistence, samples: report.groups?.slice(0, 20) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
