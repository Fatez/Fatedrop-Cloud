import fs from 'node:fs';

import { classifyPokemonSetForPulse } from '../catalogue/pokemon-set-policy.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import {
  auditExplicitCardmarketMappings,
  indexCardmarketProducts,
  loadTcgdexRepositoryEvidence,
} from './tcgdex-repository-cardmarket-evidence.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : null;
}

function readJsonFile(filePath, field) {
  if (!filePath) throw new TypeError(`${field} is required`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function releasedAt(date) {
  const value = Date.parse(String(date || ''));
  return Number.isFinite(value) ? value : null;
}

function percent(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

async function main() {
  const asOfArg = argValue('as-of');
  const asOf = asOfArg ? Date.parse(asOfArg) : Date.now();
  if (!Number.isFinite(asOf)) throw new TypeError('--as-of must be a valid date/time');

  const tcgdexRepositoryPath = argValue('tcgdex-repo');
  const tcgdexRevision = argValue('tcgdex-revision') || null;
  const canonicalUniversePath = argValue('canonical-universe');
  const canonicalUniverse = readJsonFile(canonicalUniversePath, '--canonical-universe');
  if (!Array.isArray(canonicalUniverse?.eligibleSets)) {
    throw new TypeError('canonical universe snapshot must contain eligibleSets[]');
  }

  const repository = loadTcgdexRepositoryEvidence(tcgdexRepositoryPath, { includeCards: true });
  const { artifact, products } = await fetchCardmarketPokemonSinglesCatalogue();
  const productIndex = indexCardmarketProducts(products);

  const repositoryPolicy = repository.sets.map((set) => Object.freeze({
    tcgdexSetId: set.tcgdexSetId,
    setName: set.setName,
    seriesName: set.seriesName,
    releaseDate: set.releaseDate,
    cardmarketExpansionId: set.cardmarketExpansionId,
    eligibility: classifyPokemonSetForPulse({
      tcgdexSetId: set.tcgdexSetId,
      setName: set.setName,
      seriesName: set.seriesName,
      releasedAt: releasedAt(set.releaseDate),
    }, { asOf }),
  }));
  const repositoryEligible = repositoryPolicy.filter((row) => row.eligibility.eligibleForGlobalPulse);

  const results = [];
  for (const canonical of canonicalUniverse.eligibleSets) {
    const sourceSet = repository.bySetId.get(canonical.tcgdexSetId) || null;
    if (!sourceSet) {
      results.push(Object.freeze({
        ...canonical,
        status: 'unresolved',
        reason: 'canonical_eligible_set_missing_from_pinned_tcgdex_repository',
        cardmarketExpansionId: null,
        tcgdexRepositorySet: null,
        cardAudit: null,
      }));
      continue;
    }

    const audit = auditExplicitCardmarketMappings(
      sourceSet,
      productIndex.byId,
      productIndex.byExpansion,
    );

    results.push(Object.freeze({
      tcgdexSetId: canonical.tcgdexSetId,
      pokemonTcgSetId: canonical.pokemonTcgSetId,
      canonicalSetId: canonical.canonicalSetId,
      seriesName: canonical.seriesName,
      setName: canonical.setName,
      releasedAt: canonical.releasedAt,
      printedTotal: canonical.printedTotal,
      total: canonical.total,
      matchBasis: canonical.matchBasis,
      status: audit.status,
      reason: audit.reason,
      cardmarketExpansionId: audit.cardmarketExpansionId,
      tcgdexRepositorySet: Object.freeze({
        setName: sourceSet.setName,
        seriesName: sourceSet.seriesName,
        releaseDate: sourceSet.releaseDate,
        officialCardCount: sourceSet.officialCardCount,
        officialAbbreviation: sourceSet.officialAbbreviation,
        sourcePath: sourceSet.sourcePath,
        cardFiles: sourceSet.cards.length,
      }),
      cardAudit: audit,
    }));
  }

  const summary = {
    canonicalEligibleSets: results.length,
    provenExpansionMappings: 0,
    unresolvedExpansionMappings: 0,
    cardsInProvenSets: 0,
    cardsWithVerifiedCardmarketProduct: 0,
    variantsInProvenSets: 0,
    variantsWithExplicitCardmarketProductId: 0,
    verifiedDistinctCardmarketProducts: 0,
    missingExplicitProductsFromOfficialCatalogue: 0,
    explicitProductNameConflicts: 0,
  };
  const distinctVerifiedProducts = new Set();

  for (const row of results) {
    if (row.status === 'proven') summary.provenExpansionMappings += 1;
    else summary.unresolvedExpansionMappings += 1;
    const counts = row.cardAudit?.counts;
    if (!counts || row.status !== 'proven') continue;
    summary.cardsInProvenSets += Number(counts.cards || 0);
    summary.cardsWithVerifiedCardmarketProduct += Number(counts.cardsWithVerifiedProduct || 0);
    summary.variantsInProvenSets += Number(counts.variants || 0);
    summary.variantsWithExplicitCardmarketProductId += Number(counts.variantsWithCardmarketId || 0);
    summary.missingExplicitProductsFromOfficialCatalogue += Number(counts.missingProducts || 0);
    summary.explicitProductNameConflicts += Number(counts.nameConflicts || 0);
    for (const mapping of row.cardAudit.mappings || []) {
      if (mapping.status === 'proven' && Number.isSafeInteger(Number(mapping.cardmarketProductId))) {
        distinctVerifiedProducts.add(Number(mapping.cardmarketProductId));
      }
    }
  }
  summary.verifiedDistinctCardmarketProducts = distinctVerifiedProducts.size;
  summary.cardProductCoverageAcrossProvenSets = percent(
    summary.cardsWithVerifiedCardmarketProduct,
    summary.cardsInProvenSets,
  );
  summary.variantExplicitIdCoverageAcrossProvenSets = percent(
    summary.variantsWithExplicitCardmarketProductId,
    summary.variantsInProvenSets,
  );

  const repoSummary = {
    englishSetFiles: repository.setCount,
    policyEligible: repositoryEligible.length,
    policyExcluded: repositoryPolicy.length - repositoryEligible.length,
    eligibleWithExplicitCardmarketExpansionId: repositoryEligible.filter((row) => Number.isSafeInteger(Number(row.cardmarketExpansionId))).length,
    canonicalResolvedEligibleSnapshotCount: canonicalUniverse.eligibleSets.length,
    canonicalEligibleMissingFromRepository: results.filter((row) => row.reason === 'canonical_eligible_set_missing_from_pinned_tcgdex_repository').length,
  };

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: new Date(asOf).toISOString(),
    mode: 'evidence_only',
    approved: false,
    writesPerformed: false,
    policy: {
      fuzzyMatching: false,
      cardmarketWebScraping: false,
      tcgdexApiRequired: false,
      expansionProof: 'tcgdex_reviewed_thirdParty.cardmarket_expansion_id_verified_in_official_cardmarket_catalogue',
      productProof: 'tcgdex_variant_thirdParty.cardmarket_product_id_verified_by_id_and_exact_name_in_official_cardmarket_catalogue',
      supplementalProductExpansionsPreserved: true,
    },
    canonicalUniverseSource: {
      provenance: canonicalUniverse.provenance || null,
      sourceCounts: canonicalUniverse.sourceCounts || null,
      reviewedCounts: canonicalUniverse.reviewedCounts || null,
      universe: canonicalUniverse.universe || null,
      reviewedAliasRejected: canonicalUniverse.reviewedAliasRejected || [],
      sourceErrors: canonicalUniverse.sourceErrors || [],
    },
    tcgdexRepositorySource: {
      repository: 'tcgdex/cards-database',
      revision: tcgdexRevision,
      ...repoSummary,
    },
    cardmarketSource: {
      url: artifact.url,
      fetchedAt: artifact.fetchedAt,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      etag: artifact.etag,
      lastModified: artifact.lastModified,
      catalogueProducts: products.length,
      distinctExpansionIds: productIndex.byExpansion.size,
    },
    summary,
    repositoryPolicy,
    sets: results,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
