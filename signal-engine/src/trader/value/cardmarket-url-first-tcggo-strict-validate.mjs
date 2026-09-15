import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';

const inputPath = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-full.json');
const outputPath = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-url-first-tcggo-strict.json');

const input = JSON.parse(await readFile(inputPath, 'utf8'));
if (input?.status !== 'audit_complete' || input?.productionWrites !== false) {
  throw new Error('Completed read-only full URL-first report required');
}

const comparable = (value) => {
  try { return normaliseComparableName(String(value ?? '')); } catch { return ''; }
};

function withoutAttackDescriptor(value) {
  return String(value ?? '').replace(/\s+\[[^\]]*\|[^\]]*\]\s*$/i, '').trim();
}

function reviewedProductNameMatches(identityName, productName) {
  if (!identityName || !productName) return false;
  if (rootProductNameMatches(identityName, productName)) return true;

  const providerRoot = withoutAttackDescriptor(productName);

  // Cardmarket routinely includes LV.X in product titles while canonical FateDrop
  // names for the same numbered printing omit it.
  const withoutLvX = providerRoot.replace(/\s+LV\.?\s*X\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (rootProductNameMatches(identityName, withoutLvX)) return true;

  // Provider spelling for the e-Reader/EX-era star rarity.
  const starAlias = providerRoot.replace(/\bGold Star\b/gi, 'Star');
  if (rootProductNameMatches(identityName, starAlias)) return true;

  // Named supporter suffixes are presentation text, not a different collector-number identity.
  const supporterAlias = providerRoot.replace(/\s+-\s+.+$/i, '').trim();
  if (rootProductNameMatches(identityName, supporterAlias)) return true;

  // Preserve Unown letter markers; the generic provider helper intentionally strips
  // trailing square-bracket descriptors and would otherwise drop [J].
  if (/^Unown\s+\[[A-Z]\]$/i.test(providerRoot)
      && comparable(identityName) === comparable(providerRoot)) return true;

  // Gender markers embedded after an owner's name.
  const genderAlias = providerRoot
    .replace(/Nidoran\s+\[F\]/gi, 'Nidoran female')
    .replace(/Nidoran\s+\[M\]/gi, 'Nidoran male');
  const identityGenderAlias = String(identityName)
    .replace(/♀/g, ' female')
    .replace(/♂/g, ' male');
  if (comparable(identityGenderAlias) === comparable(genderAlias)) return true;

  // Historical Cardmarket energy naming conventions.
  const exactAliases = new Map([
    ['δ Rainbow Energy', ['Rainbow Energy Delta']],
    ['Blend Energy Grass Fire Psychic Darkness', ['Blend Energy GFPD']],
    ['Blend Energy Water Lightning Fighting Metal', ['Blend Energy WLFM']],
    ['Unit Energy FightingDarknessFairy', ['Unit Energy [FDY]']],
    ['Unit Energy GrassFireWater', ['Unit Energy [GRW]']],
    ['Unit Energy LightningPsychicMetal', ['Unit Energy [LPM]']],
    ['Fairy Charm Grass', ['Fairy Charm [G]']],
    ['Fairy Charm Psychic', ['Fairy Charm [P]']],
    ['Fairy Charm Fighting', ['Fairy Charm [F]']],
    ['Fairy Charm Dragon', ['Fairy Charm [N]']],
    ['Fairy Charm Lightning', ['Fairy Charm [L]']],
  ]);
  const aliases = exactAliases.get(String(identityName));
  if (aliases?.some((alias) => comparable(alias) === comparable(providerRoot))) return true;

  return false;
}

const compatible = (row) => reviewedProductNameMatches(row?.name, row?.cardmarketProductName);

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
    reviewedNamingConventionsOnly: true,
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
