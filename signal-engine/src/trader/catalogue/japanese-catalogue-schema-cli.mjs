import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { validateProductionTarget } from './production-target-check.mjs';

async function main() {
  if (process.env.ALLOW_JAPANESE_SCHEMA_WRITE !== 'true') throw new Error('ALLOW_JAPANESE_SCHEMA_WRITE=true is required');
  validateProductionTarget(process.env.DATABASE_URL);
  const path = resolve(process.argv[2] || 'database/2026-09-13-japanese-catalogue-evidence.sql');
  const sql = await readFile(path, 'utf8');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(sql);
    console.log(JSON.stringify({ status: 'complete', migration: path, productionWrites: true }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
