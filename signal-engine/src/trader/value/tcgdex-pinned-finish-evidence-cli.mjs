import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { buildReviewedDecisionManifest } from './reviewed-finish-decision-cli.mjs';

const FINISH_TO_TCGDEX_TYPE = Object.freeze({
  standard: 'normal',
  holo: 'holo',
  reverse_holo: 'reverse',
});

const collector = value => String(value ?? '')
  .trim()
  .toUpperCase()
  .replace(/\s+/g, '')
  .replace(/(^|[^0-9])0+(?=\d)/g, '$1');

function isBaselineVariant(variant, expectedType) {
  return variant?.type === expectedType
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0;
}

function repoCardIndex(repo) {
  const byId = new Map();
  for (const set of repo?.sets || []) {
    for (const card of set?.cards || []) byId.set(card.tcgdexCardId, card);
  }
  return byId;
}

function sourceLocator(repositoryRoot, revision, card) {
  const relative = path.relative(repositoryRoot, card.sourcePath).split(path.sep).join('/');
  return `https://github.com/tcgdex/cards-database/blob/${revision}/${relative}`;
}

export function buildTcgdexPinnedReviewedEvidence(targetReport, repo, {
  revision,
  repositoryRoot,
  observedAt = Date.now(),
} = {}) {
  if (targetReport?.productionWrites !== false || !Array.isArray(targetReport?.targets)) {
    throw new Error('Expected read-only finish evidence target report');
  }
  if (!revision || targetReport.tcgdexRevision !== revision) {
    throw new Error(`Pinned TCGdex revision mismatch: report=${targetReport?.tcgdexRevision || 'missing'} runtime=${revision || 'missing'}`);
  }
  if (!repositoryRoot) throw new Error('Pinned TCGdex repository root is required');
  if ((targetReport.targetCount || 0) + (targetReport.blockedCount || 0) !== 1121) {
    throw new Error(`Expected frozen 1121 cohort, found ${(targetReport.targetCount || 0) + (targetReport.blockedCount || 0)}`);
  }

  const cards = repoCardIndex(repo);
  const reviews = [];
  const held = [...(Array.isArray(targetReport.blocked) ? targetReport.blocked : [])];

  for (const target of targetReport.targets) {
    const card = cards.get(target.tcgdexCardId);
    if (!card) {
      held.push({ cardIdentityId: target.cardIdentityId, provider: 'tcgdex', reason: 'pinned_tcgdex_card_missing' });
      continue;
    }
    if (normaliseComparableName(card.name) !== normaliseComparableName(target.name)) {
      held.push({ cardIdentityId: target.cardIdentityId, provider: 'tcgdex', reason: 'pinned_tcgdex_name_mismatch' });
      continue;
    }
    if (collector(card.localId) !== collector(target.collectorNumber)) {
      held.push({ cardIdentityId: target.cardIdentityId, provider: 'tcgdex', reason: 'pinned_tcgdex_collector_mismatch' });
      continue;
    }

    const expectedType = FINISH_TO_TCGDEX_TYPE[target.variantCode];
    if (!expectedType) {
      held.push({ cardIdentityId: target.cardIdentityId, provider: 'tcgdex', reason: 'unsupported_finish' });
      continue;
    }
    const matches = (card.variants || []).filter(variant => isBaselineVariant(variant, expectedType));
    if (!matches.length) {
      held.push({ cardIdentityId: target.cardIdentityId, provider: 'tcgdex', reason: 'target_finish_not_explicit' });
      continue;
    }

    reviews.push({
      cardIdentityId: target.cardIdentityId,
      finish: target.variantCode,
      language: target.language || 'en',
      edition: target.edition || 'unspecified',
      verdict: 'exists',
      basis: 'exact_printing_checklist',
      sourceLocator: sourceLocator(repositoryRoot, revision, card),
      observedAt,
      observedFinish: target.variantCode,
      evidencePayload: {
        source: 'tcgdex_pinned_repository',
        repository: 'tcgdex/cards-database',
        revision,
        card: {
          id: card.tcgdexCardId,
          localId: card.localId,
          name: card.name,
        },
        matchedBaselineVariants: matches.map(variant => ({
          type: variant.type,
          subtype: variant.subtype || null,
          foil: variant.foil || null,
          stamp: variant.stamp || [],
          cardmarketProductId: variant.cardmarketProductId || null,
        })),
      },
    });
  }

  const reviewed = buildReviewedDecisionManifest({
    provider: 'set_rule',
    reviewer: 'fatedrop-tcgdex-pinned-evidence',
    approvalReference: `tcgdex-pinned:${revision}`,
    reviews,
  });

  return {
    ...reviewed,
    evidenceSource: 'tcgdex_pinned_repository',
    tcgdexRevision: revision,
    held,
    counts: {
      frozenCohort: 1121,
      targets: targetReport.targets.length,
      approvedExplicitExistence: reviewed.decisions.length,
      held: held.length,
      automatedNonexistence: 0,
    },
    policy: {
      ...reviewed.policy,
      pinnedRevisionRequired: true,
      exactCardIdRequired: true,
      exactNameRequired: true,
      exactCollectorRequired: true,
      baselineVariantFieldsRequired: true,
      subtypeFoilStampNeverCollapsedToBaseline: true,
      absenceNeverMeansNonexistence: true,
      rarityNeverAuthorizesWrite: true,
      priceWritesRemainCardmarketIngestOnly: true,
    },
  };
}

async function main() {
  const targetsPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!targetsPath || !outputPath) {
    throw new Error('Usage: node tcgdex-pinned-finish-evidence-cli.mjs targets.json reviewed-evidence.json');
  }
  const repositoryRoot = process.env.TCGDEX_REPO;
  const revision = process.env.TCGDEX_REVISION;
  if (!repositoryRoot || !revision) throw new Error('TCGDEX_REPO and TCGDEX_REVISION are required');

  const targetReport = JSON.parse(await readFile(targetsPath, 'utf8'));
  const repo = loadTcgdexRepositoryEvidence(repositoryRoot, { includeCards: true });
  const reviewed = buildTcgdexPinnedReviewedEvidence(targetReport, repo, { revision, repositoryRoot });
  await writeFile(outputPath, JSON.stringify(reviewed, null, 2));
  console.log(JSON.stringify({
    provider: 'tcgdex',
    revision,
    ...reviewed.counts,
    productionWrites: reviewed.productionWrites,
    priceWrites: reviewed.priceWrites,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
