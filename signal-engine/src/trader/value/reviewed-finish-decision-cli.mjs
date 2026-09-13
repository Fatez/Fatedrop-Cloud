import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { verifySnapshot } from './finish-evidence-normalizer.mjs';

const sha256 = raw => createHash('sha256').update(raw).digest('hex');
const FINISHES = new Set(['standard', 'holo', 'reverse_holo']);
const VERDICTS = new Set(['exists', 'does_not_exist']);
const BASES = new Set(['explicit_variant_record', 'exact_printing_checklist']);

function stableSnapshot(provider, row) {
  if (!['manual', 'set_rule'].includes(provider)) throw new Error('Reviewed importer accepts manual or set_rule only');
  const rawPayload = JSON.stringify(row.evidencePayload);
  const payloadSha256 = sha256(rawPayload);
  return verifySnapshot({
    provider,
    cardIdentityId: row.cardIdentityId,
    sourceLocator: row.sourceLocator,
    requestFingerprint: sha256(JSON.stringify({ provider, cardIdentityId: row.cardIdentityId, sourceLocator: row.sourceLocator })),
    observedAt: Number(row.observedAt),
    payloadSha256,
    rawPayload,
  });
}

export function buildReviewedDecisionManifest(input) {
  if (!input || !['manual', 'set_rule'].includes(input.provider) || !Array.isArray(input.reviews)) throw new Error('Invalid reviewed evidence manifest');
  if (!input.reviewer || !input.approvalReference) throw new Error('reviewer and approvalReference are required');
  const decisions = [];
  const snapshots = {};
  const snapshotRows = [];
  const seen = new Set();
  for (const row of input.reviews) {
    if (!row.cardIdentityId || !FINISHES.has(row.finish) || !VERDICTS.has(row.verdict) || !BASES.has(row.basis)) throw new Error('Invalid reviewed decision row');
    if (input.provider === 'set_rule' && row.basis !== 'exact_printing_checklist') throw new Error('Set rules require exact_printing_checklist basis');
    if (input.provider === 'manual' && !row.humanConfirmed) throw new Error('Manual review requires explicit humanConfirmed=true');
    if (!row.sourceLocator || !row.evidencePayload || !Number.isFinite(Number(row.observedAt))) throw new Error('Reviewed evidence source is incomplete');
    const key = `${row.cardIdentityId}|${row.finish}`;
    if (seen.has(key)) throw new Error(`Duplicate reviewed finish decision: ${key}`);
    seen.add(key);
    const snapshot = stableSnapshot(input.provider, row);
    snapshots[snapshot.payloadSha256] = snapshot.rawPayload;
    snapshotRows.push({ ...snapshot, payload: undefined });
    decisions.push({
      cardIdentityId: row.cardIdentityId,
      finish: row.finish,
      language: row.language || 'en',
      edition: row.edition || 'unspecified',
      verdict: row.verdict,
      basis: row.basis,
      reviewReference: `${input.approvalReference}:${snapshot.payloadSha256}`,
      sourceLocator: row.sourceLocator,
      snapshotSha256: snapshot.payloadSha256,
      observedFinish: row.observedFinish || row.finish,
      reviewer: input.reviewer,
    });
  }
  decisions.sort((a, b) => `${a.cardIdentityId}|${a.finish}`.localeCompare(`${b.cardIdentityId}|${b.finish}`));
  snapshotRows.sort((a, b) => `${a.cardIdentityId}|${a.payloadSha256}`.localeCompare(`${b.cardIdentityId}|${b.payloadSha256}`));
  return {
    schemaVersion: 1,
    provider: input.provider,
    productionWrites: false,
    priceWrites: false,
    reviewer: input.reviewer,
    approvalReference: input.approvalReference,
    decisions,
    snapshots,
    snapshotRows,
    policy: {
      explicitApprovalRequired: true,
      priceWritesRemainCardmarketIngestOnly: true,
      noBaseCardDeletes: true,
    },
  };
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) throw new Error('Usage: node reviewed-finish-decision-cli.mjs reviewed-input.json reviewed-evidence.json');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const report = buildReviewedDecisionManifest(input);
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ provider: report.provider, reviewed: report.decisions.length, productionWrites: false, priceWrites: false }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
