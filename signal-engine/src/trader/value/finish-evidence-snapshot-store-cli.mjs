import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { verifySnapshot } from './finish-evidence-normalizer.mjs';

const idFor = snapshot => `fdevidence_${createHash('sha256').update([
  snapshot.provider,
  snapshot.cardIdentityId,
  snapshot.payloadSha256,
].join('|')).digest('hex').slice(0, 32)}`;

export async function persistEvidenceSnapshots(db, acquisition, { write = false } = {}) {
  if (acquisition?.productionWrites !== false || acquisition?.priceWrites !== false || !Array.isArray(acquisition?.snapshots)) {
    throw new Error('Expected a read-only acquisition report');
  }
  const snapshots = acquisition.snapshots.map(verifySnapshot);
  const identityIds = [...new Set(snapshots.map(row => row.cardIdentityId))];
  const { rows: identities } = identityIds.length
    ? await db.query(`SELECT id FROM fatedrop_card_identities WHERE id=ANY($1::text[])`, [identityIds])
    : { rows: [] };
  const existing = new Set(identities.map(row => row.id));
  const missing = identityIds.filter(id => !existing.has(id));
  if (missing.length) throw new Error(`Evidence target canonical identities missing: ${missing.slice(0, 10).join(',')}`);

  const report = {
    status: 'clean',
    productionWrites: false,
    priceWrites: false,
    provider: acquisition.provider,
    validatedSnapshots: snapshots.length,
    insertedSnapshots: 0,
    duplicateSnapshots: 0,
  };
  if (!write) return report;

  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-variant-evidence-snapshots'))`);
    const now = Date.now();
    for (const snapshot of snapshots) {
      const result = await db.query(`
        INSERT INTO fatedrop_variant_evidence_snapshots
          (id,card_identity_id,provider,source_locator,request_fingerprint,observed_at,payload_sha256,artifact_sha256,raw_payload_text,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (provider,card_identity_id,payload_sha256) DO NOTHING
        RETURNING id`, [
        idFor(snapshot), snapshot.cardIdentityId, snapshot.provider, snapshot.sourceLocator,
        snapshot.requestFingerprint, snapshot.observedAt, snapshot.payloadSha256,
        snapshot.artifactSha256 || null, snapshot.rawPayload, now,
      ]);
      if (result.rowCount === 1) report.insertedSnapshots += 1;
      else report.duplicateSnapshots += 1;
    }
    await db.query('COMMIT');
    report.productionWrites = true;
    return report;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (process.env.PRICE_WRITE === 'true') throw new Error('Evidence acquisition never writes prices');
  const acquisitionPath = process.argv[2];
  if (!acquisitionPath) throw new Error('Usage: node finish-evidence-snapshot-store-cli.mjs acquisition.json');
  validateProductionTarget(process.env.DATABASE_URL);
  const acquisition = JSON.parse(await readFile(acquisitionPath, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await persistEvidenceSnapshots(db, acquisition, { write: process.env.EVIDENCE_WRITE === 'true' });
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, priceWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  const output = process.env.EVIDENCE_STORE_REPORT || `${process.env.RUNNER_TEMP || '.'}/finish-evidence-store.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
