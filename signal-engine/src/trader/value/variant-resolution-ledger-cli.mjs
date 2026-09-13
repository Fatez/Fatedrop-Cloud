import { readFile, writeFile } from 'node:fs/promises';
import { snapshotHash, buildResolutionLedger } from './variant-resolution-ledger.mjs';

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (!sourcePath || !outputPath) throw new Error('Usage: node variant-resolution-ledger-cli.mjs frozen-audit.json output.json [reviewed-evidence.json]');
const raw = await readFile(sourcePath, 'utf8');
const audit = JSON.parse(raw);
if (audit.status !== 'audit_complete' || audit.productionWrites !== false || !Array.isArray(audit.held)) throw new Error('Expected completed read-only source audit');
const rows = audit.held.filter(r => r.reason === 'external_target_finish_absent')
  .map(row => ({ ...row, language: 'en', edition: 'unspecified' }));
const review = process.argv[4] ? JSON.parse(await readFile(process.argv[4], 'utf8')) : {};
const ledger = buildResolutionLedger(rows, { ...review, now: Date.now() });
ledger.inputSnapshotSha256 = snapshotHash(raw);
ledger.scope = 'Historical English standard/holo external_target_finish_absent cohort; not a current production recount';
ledger.sourceAudit = audit.source;
await writeFile(outputPath, JSON.stringify(ledger, null, 2));
console.log(JSON.stringify({ classified: ledger.classified, resolved: ledger.resolved, counts: ledger.counts, productionWrites: false }));
