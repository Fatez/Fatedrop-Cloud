import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateRehearsalTarget } from '../src/trader/catalogue/rehearsal-guard.mjs';
import { buildPrimaryCoverageLedger } from '../src/trader/catalogue/primary-coverage-ledger.mjs';
const dir = process.env.RUNNER_TEMP || '.';
validateRehearsalTarget(process.env.CATALOGUE_REHEARSAL_DATABASE_URL);
const census = JSON.parse(await readFile(`${dir}/primary-source-census.json`, 'utf8'));
const pool = new Pool({connectionString:process.env.CATALOGUE_REHEARSAL_DATABASE_URL,max:1});
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query(`SELECT m.source_name AS "sourceName", m.source_record_id AS "sourceRecordId", c.id AS "cardIdentityId", c.canonical_key AS "canonicalKey", c.variant_code AS "variantCode", c.language_code AS "languageCode" FROM fatedrop_card_source_mappings m JOIN fatedrop_card_identities c ON c.id=m.card_identity_id WHERE c.verification_status='verified' AND m.source_name='tcgdex'`);
    const ledger = buildPrimaryCoverageLedger(census, rows);
    await client.query('COMMIT');
    await writeFile(`${dir}/primary-coverage-ledger.json`,JSON.stringify(ledger,null,2));
    const summary = `# Catalogue coverage\n\nCompared against isolated rehearsal, not production.\n\nSource records: ${ledger.sourceRecords}\n\n${Object.entries(ledger.counts).map(([k,v])=>`- ${k}: ${v}`).join('\n')}\n\nUnresolved records: ${ledger.unresolvedRecords}\n\nStatus: ${ledger.completionStatus}\n\nFull canonical and price coverage remain unproven.\n`;
    await writeFile(`${dir}/primary-coverage-summary.md`,summary);
    console.log(summary);
  } finally { client.release(); }
} finally { await pool.end(); }
