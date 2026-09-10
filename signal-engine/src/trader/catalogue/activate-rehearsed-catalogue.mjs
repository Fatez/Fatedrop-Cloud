import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from './production-target-check.mjs';
import { validateRehearsalTarget } from './rehearsal-guard.mjs';

export const TABLES = Object.freeze({
  fatedrop_tcgs: ['code','status'],
  fatedrop_card_series: ['tcg_id','code','verification_status'],
  fatedrop_card_sets: ['tcg_id','series_id','code','verification_status'],
  fatedrop_card_set_source_mappings: ['set_id','source_name','source_record_id'],
  fatedrop_card_printings: ['tcg_id','series_id','set_id','printing_code','collector_number','name','verification_status'],
  fatedrop_card_identities: ['canonical_key','tcg_id','series_id','set_id','printing_id','collector_number','variant_code','language_code','verification_status'],
  fatedrop_card_source_mappings: ['card_identity_id','source_name','source_record_id','source_variant_key'],
  fatedrop_card_provenance: ['card_identity_id','source_name','source_record_id','source_variant_key','evidence_status'],
});
const QUARANTINES = ['base2','base3','base5','gym1','neo1','neo2','neo3','neo4'];
const REVISION = '8b4e387930ead7be6595b4d4c59b7ba7a3a79f08';

export function validateEvidence(report) {
  assert.equal(report.status, 'passed');
  assert.equal(report.productionWrites, false);
  assert.equal(report.sourceRevision, REVISION);
  assert.equal(report.saved.verified_sets, 157);
  assert.equal(report.saved.printings, 19087);
  assert.equal(report.saved.verified_identities, 27624);
  assert.equal(report.saved.source_mappings, 27624);
  assert.equal(report.saved.orphan_sets, 0);
  assert.equal(report.saved.orphan_printings, 0);
  assert.equal(report.saved.orphan_mappings, 0);
  assert.equal(report.saved.duplicate_identities, 0);
  assert.deepEqual(report.saved, report.replayed);
  assert.deepEqual([...report.intentionalQuarantineSetIds].sort(), [...QUARANTINES].sort());
  assert.deepEqual(report.unexplainedZeroSavedSetIds, []);
  assert.deepEqual(report.sourceFailures, []);
  assert.deepEqual(report.setBlockers ?? [], []);
  assert.equal(report.crosswalk.matched, 165);
  assert.equal(report.sets.length, 165);
}

// Existing rows are preserved in full. Structural differences block the entire
// activation; metadata differences are reported rather than silently overwritten.
export function planUnion(existing, candidate) {
  const additions = {}, differences = {}, retainedOnly = {};
  for (const [table, identityFields] of Object.entries(TABLES)) {
    const old = new Map(existing[table].map(row => [row.id, row]));
    assert.equal(old.size, existing[table].length, 'Duplicate existing IDs');
    const seen = new Set();
    additions[table] = [];
    differences[table] = [];
    for (const row of candidate[table]) {
      assert.ok(row.id && !seen.has(row.id), 'Duplicate or missing candidate ID');
      seen.add(row.id);
      const prior = old.get(row.id);
      if (!prior) { additions[table].push(row); continue; }
      for (const field of identityFields)
        assert.deepEqual(row[field], prior[field], `${table}:${row.id}: incompatible ${field}`);
      const changed = Object.keys(row).filter(field => JSON.stringify(row[field]) !== JSON.stringify(prior[field]));
      if (changed.length) differences[table].push({id: row.id, fields: changed, action: 'preserved_existing'});
    }
    retainedOnly[table] = existing[table].filter(row => !seen.has(row.id)).map(row => row.id);
  }
  return { additions, differences, retainedOnly };
}

async function snapshot(db) {
  const rows = {};
  for (const table of Object.keys(TABLES)) rows[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  return rows;
}
async function insertRows(db, rows) {
  for (const table of Object.keys(TABLES)) {
    for (let i = 0; i < rows[table].length; i += 1000) {
      // No ON CONFLICT: a different ID occupying the same natural key must fail.
      await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(rows[table].slice(i, i + 1000))]);
    }
  }
}
export async function recount(db) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM fatedrop_card_sets WHERE verification_status='verified') verified_sets,
    (SELECT count(*)::int FROM fatedrop_card_printings) printings,
    (SELECT count(*)::int FROM fatedrop_card_identities WHERE verification_status='verified') verified_identities,
    (SELECT count(*)::int FROM fatedrop_card_source_mappings) source_mappings,
    (SELECT count(*)::int FROM fatedrop_card_identities c LEFT JOIN fatedrop_card_sets s ON s.id=c.set_id WHERE s.id IS NULL) orphan_sets,
    (SELECT count(*)::int FROM fatedrop_card_identities c LEFT JOIN fatedrop_card_printings p ON p.id=c.printing_id WHERE p.id IS NULL) orphan_printings,
    (SELECT count(*)::int FROM fatedrop_card_source_mappings m LEFT JOIN fatedrop_card_identities c ON c.id=m.card_identity_id WHERE c.id IS NULL) orphan_mappings,
    (SELECT count(*)::int FROM (SELECT printing_id,variant_code,language_code FROM fatedrop_card_identities GROUP BY 1,2,3 HAVING count(*)>1) d) duplicate_identities`)).rows[0];
}
function integrity(counts) {
  for (const key of ['orphan_sets','orphan_printings','orphan_mappings','duplicate_identities']) assert.equal(counts[key], 0, key);
}

export async function activate({production, local, evidence, activate = false, report}) {
  validateEvidence(evidence);
  const schema = async db => (await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
    ORDER BY table_name,ordinal_position`, [Object.keys(TABLES)])).rows;
  assert.deepEqual(await schema(production), await schema(local), 'Production schema differs from rehearsal; migration review required');
  const candidate = await snapshot(local);
  assert.deepEqual(await recount(local), evidence.saved, 'Candidate database differs from passed rehearsal');
  integrity(evidence.saved);
  // Production stays read-only throughout compatibility verification.
  await production.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let baseline;
  try {
    baseline = await snapshot(production);
    report.before = await recount(production);
    integrity(report.before);
    assert.ok(report.before.verified_sets >= 91 && report.before.verified_identities >= 17312, 'Production baseline regressed');
  } finally { await production.query('ROLLBACK'); }
  const plan = planUnion(baseline, candidate);
  report.metadataDifferences = plan.differences;
  report.productionOnlyIds = plan.retainedOnly;
  report.additions = Object.fromEntries(Object.entries(plan.additions).map(([table, rows]) => [table, rows.length]));
  report.quarantines = evidence.intentionalQuarantineSetIds;
  report.zeroSaveSets = evidence.sets.filter(row => row.savedCards === 0);
  report.rehearsal = evidence.saved;

  // Temporary tables shadow the disposable rehearsal tables, copying their
  // checks and unique indexes. Production data never leaves this runner.
  await local.query('BEGIN');
  try {
    for (const table of Object.keys(TABLES)) await local.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`);
    await insertRows(local, baseline);
    await insertRows(local, plan.additions);
    report.expected = await recount(local);
    integrity(report.expected);
    const union = await snapshot(local);
    assert.ok(Object.values(planUnion(union, candidate).additions).every(rows => rows.length === 0), 'Replay added rows');
    report.compatibility = 'passed';
  } finally { await local.query('ROLLBACK'); }
  if (!activate) { report.status = 'compatibility_passed_no_production_writes'; return; }

  await production.query('BEGIN');
  let committed = false;
  try {
    await production.query("SET LOCAL lock_timeout = '5s'");
    await production.query("SET LOCAL statement_timeout = '120s'");
    await production.query(`LOCK TABLE ${Object.keys(TABLES).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    assert.deepEqual(await snapshot(production), baseline, 'Production changed after compatibility check; rerun required');
    await insertRows(production, plan.additions);
    report.beforeCommit = await recount(production);
    assert.deepEqual(report.beforeCommit, report.expected, 'Production union differs from compatibility rehearsal');
    integrity(report.beforeCommit);
    const combined = await snapshot(production);
    for (const table of Object.keys(TABLES)) {
      const byId = new Map(combined[table].map(row => [row.id, row]));
      for (const row of baseline[table]) assert.deepEqual(byId.get(row.id), row, `Existing row changed: ${table}:${row.id}`);
    }
    report.commitAttempted = true;
    await production.query('COMMIT');
    committed = true;
    report.commitConfirmed = true;
    report.productionWrites = true;
  } catch (error) {
    if (!committed) await production.query('ROLLBACK');
    throw error;
  }
  report.after = await recount(production);
  assert.deepEqual(report.after, report.expected, 'Post-commit recount differs; investigate concurrent activity');
  report.status = 'activated_and_verified';
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  validateRehearsalTarget(process.env.CATALOGUE_REHEARSAL_DATABASE_URL);
  const output = process.env.RUNNER_TEMP || '.';
  const report = {status:'started',productionWrites:false};
  const pools = [new Pool({connectionString:process.env.DATABASE_URL,max:1}), new Pool({connectionString:process.env.CATALOGUE_REHEARSAL_DATABASE_URL,max:1})];
  let production, local;
  try {
    production = await pools[0].connect(); local = await pools[1].connect();
    const evidence = JSON.parse(await readFile(`${output}/catalogue-rehearsal.json`, 'utf8'));
    await activate({production,local,evidence,activate:process.env.CATALOGUE_ACTIVATE === 'true',report});
  } catch (error) {
    report.status = report.productionWrites ? 'committed_audit_failed' : report.commitAttempted ? 'commit_outcome_unknown_recount_required' : 'blocked';
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    production?.release(); local?.release();
    await Promise.all(pools.map(pool => pool.end()));
    await writeFile(`${output}/catalogue-activation.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({status:report.status,productionWrites:report.productionWrites,before:report.before,expected:report.expected,after:report.after,error:report.error}));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
