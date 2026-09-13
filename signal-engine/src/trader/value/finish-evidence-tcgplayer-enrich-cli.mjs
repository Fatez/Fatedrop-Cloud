import { readFile, writeFile } from 'node:fs/promises';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { tcgdexTcgplayerProductIdsForCard } from './tcgdex-tcgplayer-product-evidence.mjs';

export function enrichTargetsWithPinnedTcgplayer(report, repositoryRoot) {
  if (report?.productionWrites !== false || !Array.isArray(report?.targets)) throw new Error('Expected read-only target report');
  if (!repositoryRoot) throw new Error('Pinned repository path is required');
  const repo = loadTcgdexRepositoryEvidence(repositoryRoot, { includeCards: true });
  const byCardId = new Map();
  for (const set of repo.sets) for (const card of set.cards) byCardId.set(card.tcgdexCardId, card);
  let exact = 0, ambiguous = 0, missing = 0;
  const targets = report.targets.map(target => {
    const card = byCardId.get(target.tcgdexCardId);
    const ids = card ? tcgdexTcgplayerProductIdsForCard(card) : [];
    if (ids.length === 1) {
      exact += 1;
      return { ...target, tcgplayerProductId: String(ids[0]), tcgplayerExactCrosswalk: true, tcgplayerCrosswalkBasis: 'pinned_tcgdex_exact_card_product_id', pinnedTcgdexTcgplayerProductIds: ids.map(String) };
    }
    if (ids.length > 1) {
      ambiguous += 1;
      return { ...target, tcgplayerExactCrosswalk: false, tcgplayerProductAmbiguity: ids.map(String), pinnedTcgdexTcgplayerProductIds: ids.map(String) };
    }
    missing += 1;
    return { ...target, tcgplayerExactCrosswalk: false, pinnedTcgdexTcgplayerProductIds: [] };
  });
  return { ...report, productionWrites: false, enrichment: { ...(report.enrichment || {}), exactTcgplayerProductIds: exact, ambiguousTcgplayerProductIds: ambiguous, missingTcgplayerProductIds: missing }, targets };
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || inputPath;
  if (!inputPath) throw new Error('Usage: node finish-evidence-tcgplayer-enrich-cli.mjs targets.json [output.json]');
  const report = JSON.parse(await readFile(inputPath, 'utf8'));
  const enriched = enrichTargetsWithPinnedTcgplayer(report, process.env.TCGDEX_REPO);
  await writeFile(outputPath, JSON.stringify(enriched, null, 2));
  console.log(JSON.stringify({ targetCount: enriched.targetCount, enrichment: enriched.enrichment, productionWrites: false }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
