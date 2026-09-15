import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const variantKey = (variantCode) => variantCode === 'holo' ? 'holo' : 'normal';
const sourceKey = (row) => `${String(row?.model?.sourceRecordId ?? '')}|${variantKey(row?.variantCode)}`;

export function validateUrlFirstReport(report) {
  if (report?.status !== 'audit_complete' || report?.productionWrites !== false) {
    throw new Error('Completed read-only URL-first report required');
  }
  const candidates = Array.isArray(report.newMappingCandidates) ? report.newMappingCandidates : [];
  const owners = new Map();
  const collisions = new Set();
  for (const row of candidates) {
    if (row?.model?.status !== 'resolved' || !row?.model?.sourceRecordId) continue;
    const key = sourceKey(row);
    const prior = owners.get(key);
    if (prior && prior !== row.cardIdentityId) collisions.add(key);
    else owners.set(key, row.cardIdentityId);
  }
  const collisionRows = candidates.filter((row) => collisions.has(sourceKey(row)));
  const safeNewMappingCandidates = candidates.filter((row) => !collisions.has(sourceKey(row)));
  const safePriceable = safeNewMappingCandidates.filter((row) => Boolean(
    row?.model?.priceEvidence?.[row.variantCode === 'holo' ? 'holo' : 'standard'],
  ));
  return Object.freeze({
    ...report,
    counts: Object.freeze({
      ...report.counts,
      modelSourceCollisionKeys: collisions.size,
      modelSourceCollisionRows: collisionRows.length,
      safeNewMappingCandidates: safeNewMappingCandidates.length,
      safeNewMappingCandidatesPriceable: safePriceable.length,
    }),
    collisionReview: Object.freeze({
      collisionKeys: Object.freeze([...collisions].sort()),
      heldRows: Object.freeze(collisionRows),
    }),
    safeNewMappingCandidates: Object.freeze(safeNewMappingCandidates),
  });
}

async function main() {
  const reportPath = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-rebuild.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const validated = validateUrlFirstReport(report);
  await writeFile(reportPath, JSON.stringify(validated, null, 2));
  console.log(JSON.stringify({
    modelSourceCollisionKeys: validated.counts.modelSourceCollisionKeys,
    modelSourceCollisionRows: validated.counts.modelSourceCollisionRows,
    safeNewMappingCandidates: validated.counts.safeNewMappingCandidates,
    safeNewMappingCandidatesPriceable: validated.counts.safeNewMappingCandidatesPriceable,
    collisionKeys: validated.collisionReview.collisionKeys,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
