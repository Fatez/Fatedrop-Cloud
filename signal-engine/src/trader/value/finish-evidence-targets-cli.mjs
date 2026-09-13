import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

export async function buildFinishEvidenceTargets(db, audit) {
  if (audit?.status !== 'audit_complete' || audit?.productionWrites !== false || !Array.isArray(audit?.held)) {
    throw new Error('Expected the completed frozen read-only finish audit');
  }
  const held = audit.held.filter(row => row.reason === 'external_target_finish_absent');
  const ids = held.map(row => row.cardIdentityId);
  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.id=ANY($1::text[])`, [ids]);
  const canonical = new Map(rows.map(row => [row.id, row]));
  const targets = [];
  const blocked = [];
  for (const row of held) {
    const current = canonical.get(row.cardIdentityId);
    if (!current) { blocked.push({ cardIdentityId: row.cardIdentityId, reason: 'canonical_identity_missing' }); continue; }
    if (current.verification_status !== 'verified' || current.language_code !== 'en' || current.variant_code !== row.variantCode) {
      blocked.push({ cardIdentityId: row.cardIdentityId, reason: 'canonical_scope_drift' }); continue;
    }
    targets.push({
      cardIdentityId: row.cardIdentityId,
      variantCode: row.variantCode,
      language: 'en',
      edition: 'unspecified',
      name: current.name,
      collectorNumber: current.collector_number,
      tcgdexCardId: row.tcgdexCardId,
      scrydexCardId: row.tcgdexCardId,
      priorExternalFinishKeys: row.externalFinishKeys || [],
      priorExternalRarity: row.externalRarity || null,
    });
  }
  targets.sort((a, b) => a.cardIdentityId.localeCompare(b.cardIdentityId));
  return {
    schemaVersion: 1,
    productionWrites: false,
    sourceScope: 'frozen external_target_finish_absent cohort',
    sourceAuditSha256: audit.source?.pokemonTcg?.sha256 || null,
    expectedHistoricalCohort: 1121,
    targetCount: targets.length,
    blockedCount: blocked.length,
    targets,
    blocked,
  };
}

async function main() {
  const auditPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!auditPath || !outputPath) throw new Error('Usage: node finish-evidence-targets-cli.mjs frozen-audit.json targets.json');
  validateProductionTarget(process.env.DATABASE_URL);
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  try {
    const report = await buildFinishEvidenceTargets(db, audit);
    if (report.targetCount + report.blockedCount !== 1121) throw new Error(`Expected historical cohort 1121, found ${report.targetCount + report.blockedCount}`);
    await writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ targetCount: report.targetCount, blockedCount: report.blockedCount, productionWrites: false }));
    if (report.blockedCount) process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
