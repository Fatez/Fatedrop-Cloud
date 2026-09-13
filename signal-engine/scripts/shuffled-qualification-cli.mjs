import fs from 'node:fs/promises';
import { dryRunRetailer } from '../src/retailers/dry-run.mjs';
import { PostgresRetailerRegistry } from '../src/retailers/postgres-registry.mjs';
import { shuffledReviewedCandidate, prepareShuffledActivation } from '../src/retailers/shuffled-reviewed.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--activate')) throw new Error('Only --activate is supported; omit for a dry-run.');
const activate = args.includes('--activate');
const report = { productionWrites: false, status: 'started', observedAt: new Date().toISOString() };
let pool;
try {
  const outcome = await dryRunRetailer(shuffledReviewedCandidate());
  report.diagnostics = outcome.diagnostics;
  prepareShuffledActivation(null, outcome.diagnostics);
  report.status = 'qualified';
  if (activate) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for activation');
    const registry = new PostgresRetailerRegistry(process.env.DATABASE_URL);
    pool = await registry.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fatedrop:retailer:shuffled'))");
      await client.query('SELECT retailer_id FROM fatedrop_retailer_registry WHERE retailer_id=$1 FOR UPDATE', ['shuffled']);
      const locked = new PostgresRetailerRegistry('', { poolProvider: () => client });
      const rows = await locked.list({ limit: 5000 });
      if (rows.some(row => row.hostname === 'shuffled.gg' && row.id !== 'shuffled')) throw new Error('Duplicate retailer hostname');
      const existing = rows.find(row => row.id === 'shuffled');
      const next = prepareShuffledActivation(existing, outcome.diagnostics);
      await locked.upsert(next);
      await client.query('COMMIT');
      report.productionWrites = true;
      report.status = 'monitoring_enabled_restart_required';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
} catch (error) {
  report.status = 'failed';
  // Do not emit connection strings or provider payloads in retained logs.
  report.error = String(error.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  await fs.writeFile('shuffled-qualification-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
