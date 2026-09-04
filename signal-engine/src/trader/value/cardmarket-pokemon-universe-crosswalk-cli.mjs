import { createPokemonTcgClient, createTcgdexClient } from '../catalogue/source-clients.mjs';
import { buildReviewedPokemonSetCrosswalk } from '../catalogue/pokemon-set-crosswalk-reviewed.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import {
  auditCardmarketCanonicalCardCoverage,
  buildCardmarketExpansionIndex,
  classifyCardmarketExpansionEvidence,
  rankCardmarketExpansionNameEvidence,
} from './cardmarket-expansion-signature-audit.mjs';

function argValue(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : null;
}

function sourceFailure(sourceName, sourceRecordId, error) {
  return Object.freeze({
    sourceName,
    sourceRecordId,
    status: error?.status ?? null,
    sourceUrl: error?.sourceUrl ?? null,
    message: error?.message || String(error),
  });
}

function unresolvedUniverseRows(base) {
  return Object.freeze({
    unmatchedTcgdex: Object.freeze((base?.unmatchedTcgdex || []).map((row) => ({ ...row }))),
    unmatchedPokemon: Object.freeze((base?.unmatchedPokemon || []).map((row) => ({ ...row }))),
    rejected: Object.freeze((base?.rejected || []).map((row) => ({ ...row }))),
    ambiguous: Object.freeze((base?.ambiguous || []).map((row) => ({ ...row }))),
  });
}

function compactCardCoverage(audit) {
  if (!audit) return null;
  return Object.freeze({
    sourceExpansionId: audit.sourceExpansionId,
    proofScope: audit.proofScope,
    variantIdentityAvailableFromPublicCatalogue: audit.variantIdentityAvailableFromPublicCatalogue,
    counts: audit.counts,
    problemSamples: Object.freeze(
      audit.diagnostics
        .filter((row) => row.status !== 'mapped_card_record')
        .slice(0, 50),
    ),
  });
}

async function main() {
  const asOfArg = argValue('as-of');
  const asOf = asOfArg ? Date.parse(asOfArg) : Date.now();
  if (!Number.isFinite(asOf)) throw new TypeError('--as-of must be a valid date/time');

  const tcgdex = createTcgdexClient({ languageCode: 'en' });
  const pokemon = createPokemonTcgClient({ apiKey: process.env.POKEMON_TCG_API_KEY || null });

  const plan = await buildReviewedPokemonSetCrosswalk({
    tcgdexClient: tcgdex,
    pokemonTcgClient: pokemon,
    asOf,
  });

  const { artifact, products } = await fetchCardmarketPokemonSinglesCatalogue();
  const expansionIndex = buildCardmarketExpansionIndex(products);
  const results = [];
  const sourceErrors = [];

  for (const set of plan.eligible) {
    let rawSet;
    try {
      rawSet = await tcgdex.getSet(set.tcgdexSetId);
    } catch (error) {
      sourceErrors.push(sourceFailure('tcgdex', set.tcgdexSetId, error));
      results.push(Object.freeze({
        ...set,
        status: 'unresolved',
        reason: 'tcgdex_set_card_briefs_unavailable',
        candidates: Object.freeze([]),
        cardCoverage: null,
      }));
      continue;
    }

    const cards = Array.isArray(rawSet?.cards) ? rawSet.cards : [];
    if (!cards.length) {
      results.push(Object.freeze({
        ...set,
        status: 'unresolved',
        reason: 'tcgdex_set_contains_no_card_briefs',
        candidates: Object.freeze([]),
        cardCoverage: null,
      }));
      continue;
    }

    let candidates;
    let classification;
    try {
      candidates = rankCardmarketExpansionNameEvidence(expansionIndex, cards, { limit: 12 });
      classification = classifyCardmarketExpansionEvidence(candidates);
    } catch (error) {
      results.push(Object.freeze({
        ...set,
        status: 'unresolved',
        reason: 'cardmarket_expansion_evidence_error',
        error: error?.message || String(error),
        candidates: Object.freeze([]),
        cardCoverage: null,
      }));
      continue;
    }

    let cardCoverage = null;
    if (classification.status === 'proven') {
      try {
        cardCoverage = compactCardCoverage(
          auditCardmarketCanonicalCardCoverage(expansionIndex, cards, classification.sourceExpansionId),
        );
      } catch (error) {
        classification = Object.freeze({
          status: 'unresolved',
          reason: 'proven_expansion_card_coverage_audit_failed',
          sourceExpansionIds: classification.sourceExpansionIds,
          sourceExpansionId: classification.sourceExpansionId,
          error: error?.message || String(error),
        });
      }
    }

    results.push(Object.freeze({
      tcgdexSetId: set.tcgdexSetId,
      pokemonTcgSetId: set.pokemonTcgSetId,
      canonicalSetId: set.canonicalSetId,
      seriesName: set.seriesName,
      setName: set.setName,
      releasedAt: set.releasedAt,
      printedTotal: set.printedTotal,
      total: set.total,
      matchBasis: set.matchBasis,
      pulseEligibility: set.pulseEligibility,
      tcgdexCardBriefs: cards.length,
      status: classification.status,
      reason: classification.reason,
      sourceExpansionIds: classification.sourceExpansionIds,
      sourceExpansionId: classification.sourceExpansionId ?? null,
      proofScope: classification.proofScope ?? null,
      productVariantIdentityProven: classification.productVariantIdentityProven ?? false,
      candidates,
      cardCoverage,
    }));
  }

  const summary = {
    eligibleResolvedSets: results.length,
    proven: 0,
    ambiguous: 0,
    unresolved: 0,
    provenCanonicalCardRefs: 0,
    mappedDistinctCanonicalCards: 0,
  };

  for (const row of results) {
    if (row.status === 'proven') summary.proven += 1;
    else if (row.status === 'ambiguous') summary.ambiguous += 1;
    else summary.unresolved += 1;
    if (row.status === 'proven' && row.cardCoverage?.counts) {
      summary.provenCanonicalCardRefs += Number(row.cardCoverage.counts.canonicalCardRefs || 0);
      summary.mappedDistinctCanonicalCards += Number(row.cardCoverage.counts.mappedDistinctCanonicalCards || 0);
    }
  }
  summary.canonicalCardRecordCoverageAcrossProvenSets = summary.provenCanonicalCardRefs > 0
    ? Number((summary.mappedDistinctCanonicalCards / summary.provenCanonicalCardRefs).toFixed(6))
    : 0;

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: new Date(asOf).toISOString(),
    mode: 'evidence_only',
    approved: false,
    writesPerformed: false,
    policy: {
      fuzzyMatching: false,
      cardmarketWebScraping: false,
      sourceAcquisition: 'official_cardmarket_public_downloads_only',
      expansionProof: 'dominant_exact_card_name_set_signature',
      cardRecordProof: 'proven_expansion_plus_exact_name_unique_within_canonical_set',
      variantIdentity: 'not_proven_by_public_product_catalogue',
    },
    pokemonUniverse: {
      sourceCounts: plan.base.sourceCounts,
      baseCounts: plan.base.counts,
      reviewedCounts: plan.counts,
      unresolvedInventory: unresolvedUniverseRows(plan.base),
      reviewedAliasRejected: plan.reviewedAliasRejected,
      sourceErrors: plan.sourceErrors,
    },
    cardmarketSource: {
      url: artifact.url,
      fetchedAt: artifact.fetchedAt,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      etag: artifact.etag,
      lastModified: artifact.lastModified,
      catalogueProducts: products.length,
      distinctExpansionIds: expansionIndex.expansionCount,
    },
    summary,
    sourceErrors,
    sets: results,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
