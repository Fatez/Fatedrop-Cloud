import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const inputPath = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-full.json');
const outputPath = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-strict.json');

const input = JSON.parse(await readFile(inputPath, 'utf8'));
if (input?.status !== 'audit_complete' || input?.productionWrites !== false) {
  throw new Error('Completed read-only full URL-first report required');
}

const compatible = (row) => Boolean(
  row?.name
  && row?.cardmarketProductName
  && rootProductNameMatches(row.name, row.cardmarketProductName)
);

const rejectedNameMismatch = [];
const safeMappings = [];
for (const row of input.safeMappings || []) {
  if (compatible(row)) safeMappings.push(row);
  else rejectedNameMismatch.push({ ...row, reason: 'OFFICIAL_CARDMARKET_PRODUCT_NAME_MISMATCH' });
}

const conflicts = [];
for (const row of input.conflicts || []) {
  if (compatible(row)) conflicts.push(row);
  else rejectedNameMismatch.push({ ...row, reason: 'OFFICIAL_CARDMARKET_PRODUCT_NAME_MISMATCH' });
}

const targetPriceable = safeMappings.filter((row) => row?.priceEvidence?.targetLane === true);
const holoBaseLaneOnly = safeMappings.filter((row) => row?.priceEvidence?.baseLaneOnlyForHolo === true);
const noPriceLane = safeMappings.filter((row) => !row?.priceEvidence?.targetLane && !row?.priceEvidence?.baseLaneOnlyForHolo);

const report = {
  status: 'audit_complete',
  productionWrites: false,
  policy: {
    exactTcgIdRequired: true,
    officialCardmarketCatalogueProductRequired: true,
    officialCardmarketProductNameCompatibilityRequired: true,
    batchCollisionFreeRequired: true,
    currentSourceOwnershipConflictHeld: true,
  },
  counts: {
    targets: input.counts?.targets ?? null,
    originalExactProductResolved: input.counts?.exactProductResolved ?? null,
    originalHeld: input.counts?.exactProductHeld ?? null,
    rejectedNameMismatch: rejectedNameMismatch.length,
    strictSafeMappings: safeMappings.length,
    strictSourceOwnedConflicts: conflicts.length,
    strictHeldTotal: (input.held || []).length + rejectedNameMismatch.length,
    strictTargetLanePriceable: targetPriceable.length,
    strictHoloBaseLaneOnly: holoBaseLaneOnly.length,
    strictNoPriceLane: noPriceLane.length,
  },
  source: input.source,
  safeMappings,
  conflicts,
  held: input.held || [],
  rejectedNameMismatch,
};

await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  status: report.status,
  counts: report.counts,
  rejectedNameMismatch: rejectedNameMismatch.map((row) => ({
    cardIdentityId: row.cardIdentityId,
    setName: row.setName,
    name: row.name,
    collectorNumber: row.collectorNumber,
    variantCode: row.variantCode,
    sourceRecordId: row.sourceRecordId,
    cardmarketProductName: row.cardmarketProductName,
  })),
  conflicts: conflicts.map((row) => ({
    cardIdentityId: row.cardIdentityId,
    setName: row.setName,
    name: row.name,
    collectorNumber: row.collectorNumber,
    sourceRecordId: row.sourceRecordId,
    cardmarketProductName: row.cardmarketProductName,
    foreignOwners: row.foreignOwners,
  })),
}, null, 2));
