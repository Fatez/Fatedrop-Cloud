import { readFile, writeFile } from 'node:fs/promises';

const setIdFrom = value => String(value || '').split('-')[0] || 'unknown';

export function buildReviewQueue(targetReport, activationPlan) {
  if (targetReport?.productionWrites !== false || !Array.isArray(targetReport?.targets)) throw new Error('Expected read-only target report');
  if (activationPlan?.productionWrites !== false || !Array.isArray(activationPlan?.rows)) throw new Error('Expected read-only activation plan');
  const targetById = new Map(targetReport.targets.map(row => [row.cardIdentityId, row]));
  const unresolved = activationPlan.rows.filter(row => row.state === 'UNRESOLVED_EVIDENCE').map(row => {
    const target = targetById.get(row.cardIdentityId) || {};
    const keys = Array.isArray(target.priorExternalFinishKeys) ? target.priorExternalFinishKeys : [];
    const queue = keys.length === 0 ? 'manual_edge_case' : row.providerDiagnostic === 'other_finish_keys_only' ? 'negative_evidence_candidate' : 'conflict_or_incomplete_source';
    return {
      cardIdentityId: row.cardIdentityId,
      tcgdexCardId: target.tcgdexCardId || null,
      setId: setIdFrom(target.tcgdexCardId),
      name: target.name || null,
      collectorNumber: target.collectorNumber || null,
      targetFinish: target.variantCode || row.finish,
      priorExternalFinishKeys: keys,
      priorExternalRarity: target.priorExternalRarity || null,
      providerDiagnostic: row.providerDiagnostic || null,
      queue,
      deckOrBoxRisk: (target.variantCode === 'standard' && keys.some(key => String(key).toLowerCase().includes('holo'))),
      tcgplayerExactCrosswalk: target.tcgplayerExactCrosswalk === true,
      tcgplayerProductId: target.tcgplayerProductId || null,
    };
  });
  const bySet = {};
  for (const row of unresolved) {
    bySet[row.setId] ||= { total: 0, negativeEvidenceCandidates: 0, manualEdgeCases: 0, deckOrBoxRisk: 0 };
    bySet[row.setId].total += 1;
    if (row.queue === 'negative_evidence_candidate') bySet[row.setId].negativeEvidenceCandidates += 1;
    if (row.queue === 'manual_edge_case') bySet[row.setId].manualEdgeCases += 1;
    if (row.deckOrBoxRisk) bySet[row.setId].deckOrBoxRisk += 1;
  }
  return {
    schemaVersion: 1,
    productionWrites: false,
    priceWrites: false,
    counts: {
      unresolved: unresolved.length,
      negativeEvidenceCandidates: unresolved.filter(row => row.queue === 'negative_evidence_candidate').length,
      manualEdgeCases: unresolved.filter(row => row.queue === 'manual_edge_case').length,
      conflictOrIncompleteSource: unresolved.filter(row => row.queue === 'conflict_or_incomplete_source').length,
      deckOrBoxRisk: unresolved.filter(row => row.deckOrBoxRisk).length,
      exactTcgplayerCrosswalk: unresolved.filter(row => row.tcgplayerExactCrosswalk).length,
    },
    bySet,
    rows: unresolved,
    policy: {
      noAutomaticInvalidation: true,
      sealedProductDecklistsRequiredBeforeNegativeDecision: true,
      alternateDistributionMustBeCovered: true,
      manualEdgeCasesRemainHeld: true,
    },
  };
}

async function main() {
  const targetsPath = process.argv[2];
  const planPath = process.argv[3];
  const outputPath = process.argv[4];
  if (!targetsPath || !planPath || !outputPath) throw new Error('Usage: node finish-evidence-review-queue-cli.mjs targets.json activation-plan.json output.json');
  const targets = JSON.parse(await readFile(targetsPath, 'utf8'));
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const report = buildReviewQueue(targets, plan);
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.counts));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
