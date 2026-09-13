import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

const REQUIRED_TABLES = [
  'fatedrop_variant_evidence_snapshots',
  'fatedrop_variant_evidence_reviews',
  'fatedrop_variant_resolution_state',
  'fatedrop_catalogue_audit_flags',
  'fatedrop_variant_audit_hold',
];

async function tableState(db) {
  const { rows } = await db.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public' AND table_name=ANY($1::text[])
    ORDER BY table_name`, [REQUIRED_TABLES]);
  const present = rows.map(row => row.table_name);
  return { present, missing: REQUIRED_TABLES.filter(name => !present.includes(name)) };
}

async function main() {
  if (process.env.PRICE_WRITE === 'true') throw new Error('Schema migration never writes prices');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  let report;
  try {
    const before = await tableState(db);
    if (process.env.SCHEMA_WRITE === 'true') {
      const sql = await readFile(new URL('../../../database/2026-09-13-variant-finish-evidence.sql', import.meta.url), 'utf8');
      if (/\bDELETE\s+FROM\b/i.test(sql) || /fatedrop_market_observations[\s\S]*INSERT/i.test(sql)) throw new Error('Unsafe schema migration content');
      await db.query(sql);
    }
    const after = await tableState(db);
    if (process.env.SCHEMA_WRITE === 'true' && after.missing.length) throw new Error(`Schema migration incomplete: ${after.missing.join(',')}`);
    report = {
      status: 'clean', productionWrites: process.env.SCHEMA_WRITE === 'true', priceWrites: false,
      before, after,
    };
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, priceWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  const output = `${process.env.RUNNER_TEMP || '.'}/finish-evidence-schema-report.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
