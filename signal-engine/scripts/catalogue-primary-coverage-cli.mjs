import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateRehearsalTarget } from '../src/trader/catalogue/rehearsal-guard.mjs';
import { buildPrimaryCoverageLedger } from '../src/trader/catalogue/primary-coverage-ledger.mjs';
import { reconcilePinnedFinishEvidence } from '../src/trader/catalogue/primary-finish-evidence.mjs';

const dir = process.env.RUNNER_TEMP || '.';
validateRehearsalTarget(process.env.CATALOGUE_REHEARSAL_DATABASE_URL);
const rawCensus = JSON.parse(await readFile(`${dir}/primary-source-census.json`, 'utf8'));
const snapshotDirectory = process.env.CATALOGUE_SOURCE_SNAPSHOT_DIR;
const snapshotVersion = process.env.CATALOGUE_TCGDEX_SNAPSHOT_VERSION;
const finishEvidence = await reconcilePinnedFinishEvidence(rawCensus, {
  snapshotDirectory,
  namespace: 'tcgdex-en',
  sourceVersion: snapshotVersion,
});
await writeFile(`${dir}/primary-finish-evidence-reconciliation.json`, JSON.stringify(finishEvidence.report, null, 2));

const pool = new Pool({connectionString:process.env.CATALOGUE_REHEARSAL_DATABASE_URL,max:1});
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query(`SELECT m.source_name AS "sourceName", m.source_record_id AS "sourceRecordId", c.id AS "cardIdentityId", c.canonical_key AS "canonicalKey", c.variant_code AS "variantCode", c.language_code AS "languageCode" FROM fatedrop_card_source_mappings m JOIN fatedrop_card_identities c ON c.id=m.card_identity_id WHERE c.verification_status='verified' AND m.source_name='tcgdex'`);
    const rawLedger = buildPrimaryCoverageLedger(rawCensus, rows);
    const ledger = buildPrimaryCoverageLedger(finishEvidence.census, rows);
    ledger.rawPinnedCounts = rawLedger.counts;
    ledger.rawPinnedUnresolvedRecords = rawLedger.unresolvedRecords;
    ledger.finishEvidenceReconciliation = {
      reconciled: finishEvidence.report.reconciled,
      rawUnknown: finishEvidence.report.rawUnknown,
      noExactSnapshot: finishEvidence.report.noExactSnapshot,
      setMismatch: finishEvidence.report.setMismatch,
      conflictingSnapshots: finishEvidence.report.conflictingSnapshots,
      origin: 'materialized_tcgdex_api_snapshot',
    };
    await client.query('COMMIT');
    await writeFile(`${dir}/primary-coverage-ledger.json`,JSON.stringify(ledger,null,2));
    const summary = `# Catalogue coverage\n\nCompared against isolated rehearsal, not production.\n\nSource records: ${ledger.sourceRecords}\n\n${Object.entries(ledger.counts).map(([k,v])=>`- ${k}: ${v}`).join('\n')}\n\nUnresolved records: ${ledger.unresolvedRecords}\n\nRaw pinned finish-scope unresolved before exact cached API reconciliation: ${rawLedger.counts.mapped_finish_scope_unresolved}\nExact cached TCGdex finish evidence reconciled: ${finishEvidence.report.reconciled}\nRemaining raw finish records without exact cached evidence: ${finishEvidence.report.noExactSnapshot}\nSnapshot conflicts: ${finishEvidence.report.conflictingSnapshots}\nSet mismatches: ${finishEvidence.report.setMismatch}\n\nStatus: ${ledger.completionStatus}\n\nPinned-source/API drift is reported explicitly; cached evidence is accepted only for exact source-card IDs with exact set identity and explicit boolean finish fields. Full canonical and price coverage remain unproven.\n`;
    await writeFile(`${dir}/primary-coverage-summary.md`,summary);
    console.log(summary);
  } finally { client.release(); }
} finally { await pool.end(); }
