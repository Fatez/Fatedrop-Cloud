import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { buildSixFingerprintRepair } from './cardmarket-six-fingerprint-repair.mjs';
import { runCardmarketPokemonMarketCycle } from './cardmarket-market-cycle.mjs';

const EXPECTED_MANIFEST = '0e426b779c7c6d1055aaca9de92771f840763c2e386e2870aedc3049d4228897';
const mode = process.env.MARKET_REPAIR_MODE || 'rehearse';
if (!['rehearse', 'activate'].includes(mode)) throw new Error('Unknown repair mode');
validateProductionTarget(process.env.DATABASE_URL);
const manifest = JSON.parse(await readFile(new URL('../../../evidence/cardmarket-six-observation-fingerprints-2026-09-15.json', import.meta.url), 'utf8'));
const repair = buildSixFingerprintRepair(manifest);
if (repair.manifestSha256 !== EXPECTED_MANIFEST) throw new Error('Frozen repair manifest digest drift');
if (mode === 'activate' && (process.env.APPROVED_MANIFEST_SHA256 !== EXPECTED_MANIFEST
  || !/^[a-f0-9]{64}$/.test(process.env.APPROVED_PRICE_GUIDE_SHA256 || ''))) {
  throw new Error('Activation requires approved manifest and price-guide digests from a successful rehearsal');
}
const schema = await readFile(new URL('../../../database/canonical-market-memory.sql', import.meta.url), 'utf8');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let client;
let report = { status: 'blocked', mode, productionWrites: false, manifestSha256: repair.manifestSha256 };
try {
  client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query("SET LOCAL lock_timeout = '10s'");
  const counts = async () => (await client.query(`SELECT
    (SELECT count(*)::int FROM fatedrop_card_identities) AS identities,
    (SELECT count(*)::int FROM fatedrop_card_source_mappings) AS mappings,
    (SELECT count(*)::int FROM fatedrop_market_observations) AS observations`)).rows[0];
  const before = await counts();
  await client.query(schema);
  await client.query(repair.sql);
  // The outer transaction owns commit/rollback, including all nested ingestion writes.
  const nestedClient = {
    query: (query, params) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query)
      ? Promise.resolve({ rows: [], rowCount: 0 }) : client.query(query, params),
    release() {},
  };
  const transactionStore = { pool: async () => ({
    query: (query, params) => client.query(query, params), connect: async () => nestedClient,
  }) };
  const cycle = await runCardmarketPokemonMarketCycle({ store: transactionStore, mode: 'persist', includeReadiness: false });
  if (mode === 'activate' && cycle.artifact.sha256 !== process.env.APPROVED_PRICE_GUIDE_SHA256) {
    throw new Error('Price-guide artifact changed since approved rehearsal');
  }
  const after = await counts();
  if (before.identities !== after.identities || before.mappings !== after.mappings
    || after.observations !== before.observations + cycle.persistence.insertedObservations) {
    throw new Error('Unexpected canonical or observation count change');
  }
  await client.query(mode === 'activate' ? 'COMMIT' : 'ROLLBACK');
  report = { status: 'complete', mode, productionWrites: mode === 'activate',
    manifestSha256: repair.manifestSha256, fingerprintRows: repair.count, before, after, cycle };
} catch (error) {
  if (client) await client.query('ROLLBACK');
  report.error = error.message;
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-six-fingerprint-repair.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
