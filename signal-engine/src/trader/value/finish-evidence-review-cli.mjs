import { readFile, writeFile } from 'node:fs/promises';
import { buildReviewedEvidence } from './finish-evidence-normalizer.mjs';

async function main() {
  const targetsPath = process.argv[2];
  const outputPath = process.argv[3];
  const acquisitionPaths = process.argv.slice(4);
  if (!targetsPath || !outputPath || acquisitionPaths.length === 0) {
    throw new Error('Usage: node finish-evidence-review-cli.mjs targets.json reviewed-evidence.json acquisition*.json');
  }
  const targetReport = JSON.parse(await readFile(targetsPath, 'utf8'));
  if (targetReport?.productionWrites !== false || !Array.isArray(targetReport?.targets)) throw new Error('Expected read-only target report');
  const snapshots = [];
  const acquisitionHolds = [];
  for (const path of acquisitionPaths) {
    const acquisition = JSON.parse(await readFile(path, 'utf8'));
    if (acquisition?.productionWrites !== false || acquisition?.priceWrites !== false || !Array.isArray(acquisition?.snapshots)) throw new Error(`Unsafe acquisition report: ${path}`);
    snapshots.push(...acquisition.snapshots);
    acquisitionHolds.push(...(Array.isArray(acquisition.held) ? acquisition.held : []));
  }
  const reviewed = buildReviewedEvidence(targetReport.targets, snapshots);
  const output = {
    schemaVersion: 1,
    productionWrites: false,
    priceWrites: false,
    decisions: reviewed.decisions,
    snapshots: reviewed.snapshots,
    held: [...acquisitionHolds, ...reviewed.held],
    counts: {
      targets: targetReport.targets.length,
      snapshots: snapshots.length,
      approvedExplicitExistence: reviewed.decisions.length,
      acquisitionOrReviewHeld: acquisitionHolds.length + reviewed.held.length,
      doesNotExistAutomated: 0,
    },
    policy: {
      absenceNeverMeansNormal: true,
      rarityNeverAuthorizesWrite: true,
      cardmarketProductIdAloneNeverProvesFinish: true,
      automatedNonexistenceDisabled: true,
      priceWritesRemainCardmarketIngestOnly: true,
    },
  };
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output.counts));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
