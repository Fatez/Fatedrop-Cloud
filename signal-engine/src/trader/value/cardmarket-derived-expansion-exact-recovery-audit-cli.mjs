import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const SOURCE_VARIANT = Object.freeze({ standard: 'normal', holo: 'holo' });
const PRICE_LANE = Object.freeze({ standard: 'standard', holo: 'holo' });
const MIN_PROVEN_PRODUCTS = 5;
const key = (...parts) => parts.join('|');

// Intentionally identical to the already-shipped provider-suffix recovery rule.
// This audit does not introduce any new naming relaxation.
function stripProviderDescriptors(name) {
  let value = String(name || '').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i, 'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i, 'Nidoran male');
  const suffix = /\s+\[[^[\]]+\]\s*$/;
  while (suffix.test(value)) value = value.replace(suffix, '').trim();
  return value;
}

function positiveExpansionId(product) {
  const value = Number(product?.sourceExpansionId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function canonicalName(value) {
  return normaliseComparableName(typeof value === 'string' ? value : '');
}

function providerBaseName(value) {
  return normaliseComparableName(stripProviderDescriptors(value));
}

async function buildAudit(db) {
  const [{ artifact: catalogueArtifact, products }, { artifact: priceArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id, i.printing_id, i.variant_code, i.set_id, p.name, p.collector_number, s.name AS set_name
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND s.verification_status='verified'`);
  const { rows: mappings } = await db.query(`
    SELECT m.card_identity_id, m.source_record_id, m.source_variant_key, i.set_id
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
    WHERE m.source_name='cardmarket'
      AND m.source_variant_key IN ('normal','holo')
      AND i.verification_status='verified'
      AND i.language_code='en'`);

  const mappedIdentityIds = new Set(mappings.map((row) => row.card_identity_id));
  const sourceOwner = new Map(mappings.map((row) => [key(row.source_record_id, row.source_variant_key), row.card_identity_id]));
  const canonicalOwner = new Map(mappings.map((row) => [key(row.card_identity_id, row.source_variant_key), String(row.source_record_id)]));

  // Exact provider-base name must identify one and only one canonical printing in the set.
  const printingsBySetName = new Map();
  for (const identity of identities) {
    const name = canonicalName(identity.name);
    if (!name) continue;
    const k = key(identity.set_id, name);
    const ids = printingsBySetName.get(k) || new Set();
    ids.add(identity.printing_id);
    printingsBySetName.set(k, ids);
  }

  // Prove expansion scope only from already accepted production mappings.
  const mappedProductsBySet = new Map();
  for (const row of mappings) {
    const ids = mappedProductsBySet.get(row.set_id) || new Set();
    ids.add(String(row.source_record_id));
    mappedProductsBySet.set(row.set_id, ids);
  }
  const setEvidence = new Map();
  const rejectedSetEvidence = [];
  for (const [setId, sourceIds] of mappedProductsBySet) {
    const resolved = [...sourceIds].map((sourceRecordId) => ({ sourceRecordId, product: productById.get(sourceRecordId) }));
    const missing = resolved.filter((row) => !row.product).map((row) => row.sourceRecordId);
    const expansions = new Set(resolved.map((row) => positiveExpansionId(row.product)).filter(Boolean));
    const reason = missing.length
      ? 'existing_mapping_product_missing_from_current_catalogue'
      : sourceIds.size < MIN_PROVEN_PRODUCTS
        ? 'insufficient_existing_exact_products'
        : expansions.size !== 1
          ? 'existing_mappings_span_multiple_cardmarket_expansions'
          : null;
    if (reason) {
      rejectedSetEvidence.push({ setId, reason, mappedProducts: sourceIds.size, missingProducts: missing.length, expansions: [...expansions] });
      continue;
    }
    setEvidence.set(setId, {
      sourceExpansionId: [...expansions][0],
      mappedProducts: sourceIds.size,
      evidenceSourceRecordIds: [...sourceIds].sort(),
    });
  }

  // Reuse the shipped provider-suffix normalization, but only inside a derived expansion proven above.
  const productsByExpansionBase = new Map();
  for (const product of products) {
    const expansionId = positiveExpansionId(product);
    const base = providerBaseName(product.name);
    if (!expansionId || !base) continue;
    const k = key(expansionId, base);
    const bucket = productsByExpansionBase.get(k) || [];
    bucket.push(product);
    productsByExpansionBase.set(k, bucket);
  }

  const rawCandidates = [];
  const reasons = {};
  const unresolvedDiagnostics = [];
  let eligibleUnmapped = 0;
  let inProvenDerivedExpansion = 0;
  let canonicalNameUniquePrinting = 0;
  let exactUniqueProviderBaseProduct = 0;
  let targetLanePriceable = 0;

  const addReason = (reason, identity, extra = {}) => {
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (unresolvedDiagnostics.length < 3000) unresolvedDiagnostics.push({
      id: identity.id,
      setId: identity.set_id,
      setName: identity.set_name,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
      reason,
      ...extra,
    });
  };

  for (const identity of identities) {
    if (mappedIdentityIds.has(identity.id)) continue;
    eligibleUnmapped++;
    const evidence = setEvidence.get(identity.set_id);
    if (!evidence) {
      addReason('no_strict_derived_expansion_evidence', identity);
      continue;
    }
    inProvenDerivedExpansion++;

    const name = canonicalName(identity.name);
    const canonicalPrintings = printingsBySetName.get(key(identity.set_id, name)) || new Set();
    if (!name || canonicalPrintings.size !== 1 || !canonicalPrintings.has(identity.printing_id)) {
      addReason('canonical_name_not_unique_to_one_printing_in_set', identity, { canonicalPrintingCount: canonicalPrintings.size });
      continue;
    }
    canonicalNameUniquePrinting++;

    const productMatches = productsByExpansionBase.get(key(evidence.sourceExpansionId, name)) || [];
    if (productMatches.length !== 1) {
      addReason(productMatches.length === 0 ? 'no_exact_provider_base_name_in_derived_expansion' : 'multiple_provider_base_name_products_in_derived_expansion', identity, {
        sourceExpansionId: evidence.sourceExpansionId,
        matchCount: productMatches.length,
      });
      continue;
    }
    exactUniqueProviderBaseProduct++;

    const product = productMatches[0];
    const sourceRecordId = String(product.sourceRecordId);
    const sourceVariantKey = SOURCE_VARIANT[identity.variant_code];
    const priceLane = PRICE_LANE[identity.variant_code];
    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, priceLane)) {
      addReason('exact_product_has_no_meaningful_target_finish_lane', identity, { sourceRecordId, sourceVariantKey, sourceExpansionId: evidence.sourceExpansionId, cardmarketProductName: product.name });
      continue;
    }
    targetLanePriceable++;

    const sourceKey = key(sourceRecordId, sourceVariantKey);
    const canonicalKey = key(identity.id, sourceVariantKey);
    if (sourceOwner.has(sourceKey) && sourceOwner.get(sourceKey) !== identity.id) {
      addReason('target_source_finish_owned_by_other_identity', identity, { sourceRecordId, sourceVariantKey, existingCardIdentityId: sourceOwner.get(sourceKey) });
      continue;
    }
    if (canonicalOwner.has(canonicalKey) && canonicalOwner.get(canonicalKey) !== sourceRecordId) {
      addReason('target_identity_finish_owned_by_other_product', identity, { sourceRecordId, sourceVariantKey, existingSourceRecordId: canonicalOwner.get(canonicalKey) });
      continue;
    }

    rawCandidates.push({
      cardIdentityId: identity.id,
      printingId: identity.printing_id,
      setId: identity.set_id,
      setName: identity.set_name,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
      sourceRecordId,
      sourceVariantKey,
      sourceExpansionId: evidence.sourceExpansionId,
      cardmarketProductName: product.name,
      priceLane,
      proof: {
        method: 'existing_exact_mappings_prove_single_expansion_then_shipped_provider_suffix_rule_unique_on_both_sides',
        existingMappedProductsInSet: evidence.mappedProducts,
        minimumRequiredMappedProducts: MIN_PROVEN_PRODUCTS,
        canonicalPrintingCountForBaseName: canonicalPrintings.size,
        cardmarketProductCountForBaseNameInExpansion: productMatches.length,
      },
    });
  }

  const sourceBatchOwners = new Map();
  const canonicalBatchOwners = new Map();
  const conflictedSourceKeys = new Set();
  const conflictedCanonicalKeys = new Set();
  for (const row of rawCandidates) {
    const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
    const canonicalKey = key(row.cardIdentityId, row.sourceVariantKey);
    const priorSource = sourceBatchOwners.get(sourceKey);
    const priorCanonical = canonicalBatchOwners.get(canonicalKey);
    if (priorSource && priorSource !== row.cardIdentityId) conflictedSourceKeys.add(sourceKey);
    else sourceBatchOwners.set(sourceKey, row.cardIdentityId);
    if (priorCanonical && priorCanonical !== row.sourceRecordId) conflictedCanonicalKeys.add(canonicalKey);
    else canonicalBatchOwners.set(canonicalKey, row.sourceRecordId);
  }
  const safeCandidates = rawCandidates.filter((row) =>
    !conflictedSourceKeys.has(key(row.sourceRecordId, row.sourceVariantKey))
    && !conflictedCanonicalKeys.has(key(row.cardIdentityId, row.sourceVariantKey)));

  const bySet = {};
  for (const row of safeCandidates) {
    const current = bySet[row.setName] || { count: 0, sourceExpansionId: row.sourceExpansionId };
    current.count++;
    bySet[row.setName] = current;
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: { cardmarketCatalogueSha256: catalogueArtifact.sha256, cardmarketPriceGuideSha256: priceArtifact.sha256 },
    policy: {
      minExistingMappedProductsForDerivedExpansion: MIN_PROVEN_PRODUCTS,
      singleExpansionRequired: true,
      shippedProviderSuffixRuleOnly: true,
      canonicalBaseNameMustIdentifyOnePrinting: true,
      cardmarketBaseNameMustIdentifyOneProductInsideExpansion: true,
      meaningfulTargetFinishPriceLaneRequired: true,
    },
    counts: {
      eligibleUnmappedNormalHolo: eligibleUnmapped,
      setsWithStrictDerivedExpansionEvidence: setEvidence.size,
      rejectedSetEvidence: rejectedSetEvidence.length,
      inProvenDerivedExpansion,
      canonicalNameUniquePrinting,
      exactUniqueProviderBaseProduct,
      targetLanePriceable,
      safeExactMappings: safeCandidates.length,
      batchSourceConflicts: conflictedSourceKeys.size,
      batchCanonicalConflicts: conflictedCanonicalKeys.size,
    },
    reasons,
    bySet,
    candidates: safeCandidates,
    rejectedSetEvidence,
    unresolvedDiagnostics,
  };
}

async function main() {
  if (process.env.MAPPING_WRITE === 'true') throw new Error('This CLI is audit-only and cannot write mappings');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await buildAudit(db);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-derived-expansion-exact-recovery-audit.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, counts: report.counts, bySet: report.bySet }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
