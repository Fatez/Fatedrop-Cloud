import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { persistVerifiedPrintingArtwork, getPrintingArtworkCoverageFromStore } from './artwork-store.mjs';
import { validateProductionTarget } from './production-target-check.mjs';
import { validateRehearsalTarget } from './rehearsal-guard.mjs';

function storeFor(pool) { return { pool: async () => pool }; }

async function candidateArtworkRows(db) {
  const { rows } = await db.query(`
    SELECT id, attributes
    FROM fatedrop_card_printings
    WHERE verification_status='verified'
      AND NULLIF(attributes->'artwork'->>'thumbnailUrl','') IS NOT NULL
    ORDER BY id`);
  return rows;
}

async function missingProductionIds(db) {
  const { rows } = await db.query(`
    SELECT id
    FROM fatedrop_card_printings
    WHERE verification_status='verified'
      AND NULLIF(attributes->'artwork'->>'thumbnailUrl','') IS NULL
    ORDER BY id`);
  return rows.map((row) => row.id);
}

export async function planArtworkBackfill({ production, rehearsal }) {
  const productionStore = storeFor(production);
  const rehearsalStore = storeFor(rehearsal);
  const before = await getPrintingArtworkCoverageFromStore(productionStore);
  const candidateCoverage = await getPrintingArtworkCoverageFromStore(rehearsalStore);

  assert.equal(candidateCoverage.total, 20023, 'Rehearsal printing count changed');
  assert.equal(candidateCoverage.withThumbnail, 20023, 'Rehearsal does not have complete artwork coverage');
  assert.equal(candidateCoverage.missing.length, 0, 'Rehearsal artwork gaps remain');

  const candidateRows = await candidateArtworkRows(rehearsal);
  assert.equal(candidateRows.length, 20023, 'Candidate artwork row count changed');

  const missingIds = await missingProductionIds(production);
  const missingSet = new Set(missingIds);
  const rows = candidateRows.filter((row) => missingSet.has(row.id));
  assert.equal(rows.length, missingIds.length, 'Some production artwork gaps are absent from rehearsal evidence');

  return Object.freeze({
    before,
    candidateCoverage,
    planned: rows.length,
    rows: Object.freeze(rows),
  });
}

export async function executeArtworkBackfill({ production, rehearsal, write = false, observedAt = Date.now() }) {
  const plan = await planArtworkBackfill({ production, rehearsal });
  const report = {
    status: write ? 'write_started' : 'dry_run_passed',
    productionWrites: false,
    before: plan.before,
    rehearsal: plan.candidateCoverage,
    planned: plan.planned,
  };
  if (!write) return report;

  await production.query('BEGIN');
  try {
    await production.query("SET LOCAL lock_timeout='5s'");
    await production.query("SET LOCAL statement_timeout='120s'");
    const saved = await persistVerifiedPrintingArtwork(storeFor(production), plan.rows, { observedAt });
    assert.equal(saved.saved, plan.planned, 'Artwork write count differs from plan');
    await production.query('COMMIT');
    report.productionWrites = true;
    report.saved = saved.saved;
  } catch (error) {
    await production.query('ROLLBACK');
    throw error;
  }

  report.after = await getPrintingArtworkCoverageFromStore(storeFor(production));
  assert.equal(report.after.total, 20023, 'Production printing count changed during artwork backfill');
  assert.equal(report.after.withThumbnail, 20023, 'Production artwork coverage is not complete after backfill');
  assert.equal(report.after.missing.length, 0, 'Production artwork gaps remain after backfill');
  report.status = 'backfill_verified';
  return report;
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  validateRehearsalTarget(process.env.CATALOGUE_REHEARSAL_DATABASE_URL);
  const output = process.env.RUNNER_TEMP || '.';
  const report = { status: 'started', productionWrites: false };
  const pools = [
    new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }),
    new Pool({ connectionString: process.env.CATALOGUE_REHEARSAL_DATABASE_URL, max: 1 }),
  ];
  let production, rehearsal;
  try {
    production = await pools[0].connect();
    rehearsal = await pools[1].connect();
    Object.assign(report, await executeArtworkBackfill({
      production,
      rehearsal,
      write: process.env.ARTWORK_WRITE === 'true',
    }));
  } catch (error) {
    report.status = report.productionWrites ? 'committed_audit_failed' : 'blocked';
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    production?.release();
    rehearsal?.release();
    await Promise.all(pools.map((pool) => pool.end()));
    await writeFile(`${output}/catalogue-artwork-backfill.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
