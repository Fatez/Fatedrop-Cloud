import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

const REPORT_PATH = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-strict.json');
const stableId = (parts) => `fdcardmap_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;

function candidateDigest(rows) {
  return createHash('sha256')
    .update([...rows]
      .map((row) => `${row.cardIdentityId}|${row.sourceRecordId}|${row.sourceVariantKey}`)
      .sort()
      .join('\n'))
    .digest('hex');
}

async function persist(db, report) {
  const candidates = report.safeMappings || [];
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-url-first-rebuild'))`);
    let insertedMappings = 0;
    for (const row of candidates) {
      const { rows: identityRows } = await db.query(`
        SELECT id,variant_code,language_code,verification_status
        FROM fatedrop_card_identities WHERE id=$1 FOR UPDATE`, [row.cardIdentityId]);
      const identity = identityRows[0];
      if (!identity
        || identity.verification_status !== 'verified'
        || identity.language_code !== 'en'
        || identity.variant_code !== row.variantCode) {
        throw new Error(`Canonical identity changed: ${row.cardIdentityId}`);
      }

      const { rows: stateRows } = await db.query(`
        SELECT classifier_state FROM fatedrop_variant_resolution_state WHERE card_identity_id=$1`, [row.cardIdentityId]);
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(stateRows[0]?.classifier_state)) {
        throw new Error(`Resolution state changed: ${row.cardIdentityId}`);
      }

      const existingIdentity = await db.query(`
        SELECT id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`, [row.cardIdentityId]);
      if (existingIdentity.rowCount) throw new Error(`Identity already mapped: ${row.cardIdentityId}`);

      const existingSource = await db.query(`
        SELECT id,card_identity_id FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`,
        [row.sourceRecordId, row.sourceVariantKey]);
      if (existingSource.rowCount) throw new Error(`Source key already owned: ${row.sourceRecordId}/${row.sourceVariantKey}`);

      const now = Date.now();
      const id = stableId([row.cardIdentityId, 'cardmarket', String(row.sourceRecordId), row.sourceVariantKey]);
      const inserted = await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)
        RETURNING id`, [
        id,
        row.cardIdentityId,
        String(row.sourceRecordId),
        row.sourceVariantKey,
        report.source?.cardmarketCatalogueSha256 || null,
        now,
      ]);
      insertedMappings += inserted.rowCount;
    }
    await db.query('COMMIT');
    return { insertedMappings };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const report = JSON.parse(await readFile(REPORT_PATH, 'utf8'));
  if (report?.status !== 'audit_complete' || report?.productionWrites !== false) {
    throw new Error('Completed read-only strict URL-first report required');
  }
  if ((report.rejectedNameMismatch || []).some((row) => (report.safeMappings || []).some((safe) => safe.cardIdentityId === row.cardIdentityId))) {
    throw new Error('Rejected identity leaked into safe mapping set');
  }

  const expectedCount = Number(process.env.EXPECTED_MAPPING_COUNT || 0);
  const expectedDigest = String(process.env.EXPECTED_MAPPING_DIGEST || '').trim();
  const actualCount = (report.safeMappings || []).length;
  const actualDigest = candidateDigest(report.safeMappings || []);
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) throw new Error('EXPECTED_MAPPING_COUNT is required');
  if (!expectedDigest) throw new Error('EXPECTED_MAPPING_DIGEST is required');
  if (actualCount !== expectedCount) throw new Error(`Safe mapping count drift: expected ${expectedCount}, found ${actualCount}`);
  if (actualDigest !== expectedDigest) throw new Error(`Safe mapping digest drift: expected ${expectedDigest}, found ${actualDigest}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let output;
  try {
    const { rows: current } = await db.query(`
      SELECT COUNT(*)::int AS mapped
      FROM fatedrop_card_source_mappings m
      JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      WHERE m.source_name='cardmarket'
        AND i.verification_status='verified'
        AND i.language_code='en'
        AND i.variant_code IN ('standard','holo')
        AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')`);
    const beforeMapped = current[0]?.mapped ?? null;
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persist(db, report);
      const { rows: afterRows } = await db.query(`
        SELECT COUNT(*)::int AS mapped
        FROM fatedrop_card_source_mappings m
        JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
        JOIN fatedrop_card_printings p ON p.id=i.printing_id
        LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
        WHERE m.source_name='cardmarket'
          AND i.verification_status='verified'
          AND i.language_code='en'
          AND i.variant_code IN ('standard','holo')
          AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')`);
      output = {
        status: 'write_complete', productionWrites: true, actualCount, actualDigest,
        beforeMapped, afterMapped: afterRows[0]?.mapped ?? null, persistence,
      };
    } else {
      output = { status: 'rehearsal_passed', productionWrites: false, actualCount, actualDigest, beforeMapped };
    }
  } finally {
    db.release();
    await pool.end();
  }
  const outputPath = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-mapping-release.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const output = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    const outputPath = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-mapping-release.json');
    await writeFile(outputPath, JSON.stringify(output, null, 2));
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  });
}
