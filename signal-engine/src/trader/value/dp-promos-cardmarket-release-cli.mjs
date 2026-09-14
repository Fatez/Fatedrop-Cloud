import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { build as buildDpPromoAudit } from './dp-promos-cardmarket-crosswalk-audit-cli.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function assertExpectedRelease(report) {
  const expectedResidual = Number(process.env.EXPECTED_DP_PROMO_RESIDUAL || 0);
  const expectedSafe = Number(process.env.EXPECTED_DP_PROMO_SAFE || 0);
  const expectedPriceable = Number(process.env.EXPECTED_DP_PROMO_PRICEABLE || 0);
  const expectedExpansion = Number(process.env.EXPECTED_DP_PROMO_EXPANSION || 0);
  const expectedDigest = String(process.env.EXPECTED_DP_PROMO_CANDIDATE_DIGEST || '').trim();
  const expectedCatalogueSha = String(process.env.EXPECTED_CARDMARKET_CATALOGUE_SHA256 || '').trim();

  if (expectedResidual > 0 && report.counts.residualDpPromoIdentities !== expectedResidual) {
    throw new Error(`DP promo residual drift: expected ${expectedResidual}, found ${report.counts.residualDpPromoIdentities}`);
  }
  if (expectedSafe > 0 && report.counts.safeExactMappings !== expectedSafe) {
    throw new Error(`DP promo safe mapping drift: expected ${expectedSafe}, found ${report.counts.safeExactMappings}`);
  }
  if (expectedPriceable > 0 && report.counts.supportedCentralPriceNow !== expectedPriceable) {
    throw new Error(`DP promo priceable drift: expected ${expectedPriceable}, found ${report.counts.supportedCentralPriceNow}`);
  }
  if (expectedExpansion > 0 && Number(report.source.provenCardmarketExpansionId) !== expectedExpansion) {
    throw new Error(`DP promo expansion drift: expected ${expectedExpansion}, found ${report.source.provenCardmarketExpansionId}`);
  }
  if (expectedDigest && report.candidateDigest !== expectedDigest) throw new Error('DP promo candidate manifest drift');
  if (expectedCatalogueSha && report.source.cardmarketCatalogueSha256 !== expectedCatalogueSha) throw new Error('Cardmarket catalogue SHA drift');

  if (process.env.MAPPING_WRITE === 'true') {
    if (!expectedResidual || !expectedSafe || !expectedPriceable || !expectedExpansion || !expectedDigest || !expectedCatalogueSha) {
      throw new Error('Production DP promo writes require pinned release counts, expansion, candidate digest and catalogue hash');
    }
    if (report.counts.batchCollisionKeys !== 0) throw new Error('DP promo batch collisions remain');
    if (report.counts.safeExactMappings !== report.candidates.length) throw new Error('DP promo candidate count is internally inconsistent');
  }
}

async function persist(db, report) {
  if (report.status !== 'audit_complete' || report.productionWrites !== false) throw new Error('Read-only DP promo audit report required');
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-dp-promo-cardmarket-release'))`);
    let insertedMappings = 0;
    for (const row of report.candidates) {
      const target = await db.query(`
        SELECT i.id,i.variant_code,i.language_code,i.verification_status
        FROM fatedrop_card_identities i
        WHERE i.id=$1
        FOR UPDATE`, [row.cardIdentityId]);
      const current = target.rows[0];
      if (!current || current.verification_status !== 'verified' || current.language_code !== 'en' || current.variant_code !== row.variantCode) {
        throw new Error(`Canonical identity changed: ${row.cardIdentityId}`);
      }

      const state = await db.query(`
        SELECT classifier_state
        FROM fatedrop_variant_resolution_state
        WHERE card_identity_id=$1`, [row.cardIdentityId]);
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(state.rows[0]?.classifier_state)) {
        throw new Error(`Resolution state changed: ${row.cardIdentityId}`);
      }

      const canonical = await db.query(`
        SELECT source_record_id,source_variant_key
        FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND card_identity_id=$1
        FOR UPDATE`, [row.cardIdentityId]);
      if (canonical.rowCount) throw new Error(`Identity already mapped: ${row.cardIdentityId}`);

      const source = await db.query(`
        SELECT card_identity_id
        FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2
        FOR UPDATE`, [row.sourceRecordId, row.sourceVariantKey]);
      if (source.rowCount) throw new Error(`Source key already owned: ${row.sourceRecordId}/${row.sourceVariantKey}`);

      const now = Date.now();
      const result = await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)
        RETURNING id`, [row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceVersion,now]);
      insertedMappings += result.rowCount;
    }
    await db.query('COMMIT');
    return Object.freeze({ insertedMappings });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function buildRelease(db) {
  const audit = await buildDpPromoAudit(db);
  if (audit.status !== 'audit_complete') throw new Error(`DP promo audit did not complete: ${audit.status}`);
  const candidateDigest = digest(audit.candidates);
  return Object.freeze({
    ...audit,
    policy: Object.freeze({
      ...audit.policy,
      currentPriceGuideRevalidatedAtActivation: true,
      volatilePriceGuideShaIsEvidenceNotIdentityPin: true,
    }),
    candidateDigest,
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await buildRelease(db);
    assertExpectedRelease(report);
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persist(db, report);
      report = Object.freeze({ ...report, status: 'write_complete', productionWrites: true, persistence });
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }

  await writeFile(`${process.env.RUNNER_TEMP || '.'}/dp-promos-cardmarket-release.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    productionWrites: report.productionWrites,
    source: report.source,
    counts: report.counts,
    reasons: report.reasons,
    candidateDigest: report.candidateDigest,
    persistence: report.persistence,
    error: report.error,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
