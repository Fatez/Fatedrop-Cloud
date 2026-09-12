import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const SOURCE_VARIANT = Object.freeze({ standard: 'normal', holo: 'holo' });
const PRICE_LANE = Object.freeze({ standard: 'standard', holo: 'holo' });
const MIN_PROVEN_PRODUCTS = 5;

const pairKey = (...parts) => parts.join('|');

function positiveExpansionId(product) {
  const value = Number(product?.sourceExpansionId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function printingKey(name, collectorNumber) {
  try {
    return `${normaliseCollectorNumber(collectorNumber)}|${normaliseComparableName(name)}`;
  } catch {
    return null;
  }
}

function productPrintingKey(product) {
  const parsed = parseCardmarketSingleProductName(product?.name);
  if (!parsed) return null;
  return `${parsed.collectorNumber}|${normaliseComparableName(parsed.cardName)}`;
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
  const sourceOwner = new Map(mappings.map((row) => [pairKey(row.source_record_id, row.source_variant_key), row.card_identity_id]));
  const canonicalOwner = new Map(mappings.map((row) => [pairKey(row.card_identity_id, row.source_variant_key), String(row.source_record_id)]));

  const mappedProductsBySet = new Map();
  for (const row of mappings) {
    const setProducts = mappedProductsBySet.get(row.set_id) || new Set();
    setProducts.add(String(row.source_record_id));
    mappedProductsBySet.set(row.set_id, setProducts);
  }

  const setEvidence = new Map();
  const rejectedSetEvidence = [];
  for (const [setId, sourceIds] of mappedProductsBySet) {
    const rows = [...sourceIds].map((sourceRecordId) => ({ sourceRecordId, product: productById.get(sourceRecordId) }));
    const missing = rows.filter((row) => !row.product).map((row) => row.sourceRecordId);
    const expansions = new Set(rows.map((row) => positiveExpansionId(row.product)).filter(Boolean));
    const parsed = rows.map((row) => parseCardmarketSingleProductName(row.product?.name)).filter(Boolean);
    const sourceSetCodes = new Set(parsed.map((row) => String(row.sourceSetCode).trim().toUpperCase()).filter(Boolean));
    const reason = missing.length
      ? 'existing_mapping_product_missing_from_current_catalogue'
      : sourceIds.size < MIN_PROVEN_PRODUCTS
        ? 'insufficient_existing_exact_products'
        : expansions.size !== 1
          ? 'existing_mappings_span_multiple_cardmarket_expansions'
          : parsed.length !== rows.length
            ? 'existing_mapping_product_lacks_structured_cardmarket_identity'
            : sourceSetCodes.size !== 1
              ? 'existing_mappings_span_multiple_cardmarket_set_codes'
              : null;
    if (reason) {
      rejectedSetEvidence.push({ setId, reason, mappedProducts: sourceIds.size, missingProducts: missing.length, expansions: [...expansions], sourceSetCodes: [...sourceSetCodes] });
      continue;
    }
    setEvidence.set(setId, {
      sourceExpansionId: [...expansions][0],
      sourceSetCode: [...sourceSetCodes][0],
      mappedProducts: sourceIds.size,
      evidenceSourceRecordIds: [...sourceIds].sort(),
    });
  }

  const productsByExpansionPrintingKey = new Map();
  for (const product of products) {
    const expansionId = positiveExpansionId(product);
    const structuredKey = productPrintingKey(product);
    const parsed = parseCardmarketSingleProductName(product.name);
    if (!expansionId || !structuredKey || !parsed) continue;
    const indexKey = pairKey(expansionId, structuredKey);
    const bucket = productsByExpansionPrintingKey.get(indexKey) || [];
    bucket.push({ product, parsed });
    productsByExpansionPrintingKey.set(indexKey, bucket);
  }

  const candidates = [];
  const reasons = {};
  const unresolvedDiagnostics = [];
  let eligibleUnmapped = 0;
  let inProvenDerivedExpansion = 0;
  let exactUniqueProduct = 0;
  let targetLanePriceable = 0;

  const addReason = (reason, identity, extra = {}) => {
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (unresolvedDiagnostics.length < 2000) unresolvedDiagnostics.push({ id: identity.id, setId: identity.set_id, setName: identity.set_name, name: identity.name, collectorNumber: identity.collector_number, variantCode: identity.variant_code, reason, ...extra });
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

    const canonicalKey = printingKey(identity.name, identity.collector_number);
    if (!canonicalKey) {
      addReason('canonical_printing_key_unavailable', identity);
      continue;
    }
    const matches = productsByExpansionPrintingKey.get(pairKey(evidence.sourceExpansionId, canonicalKey)) || [];
    const sameSetCode = matches.filter(({ parsed }) => String(parsed.sourceSetCode).trim().toUpperCase() === evidence.sourceSetCode);
    if (sameSetCode.length !== 1) {
      addReason(sameSetCode.length === 0 ? 'no_exact_product_in_derived_expansion' : 'multiple_exact_products_in_derived_expansion', identity, { sourceExpansionId: evidence.sourceExpansionId, sourceSetCode: evidence.sourceSetCode, matchCount: sameSetCode.length });
      continue;
    }
    exactUniqueProduct++;

    const { product } = sameSetCode[0];
    const sourceRecordId = String(product.sourceRecordId);
    const sourceVariantKey = SOURCE_VARIANT[identity.variant_code];
    const priceLane = PRICE_LANE[identity.variant_code];
    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, priceLane)) {
      addReason('exact_product_has_no_meaningful_target_finish_lane', identity, { sourceRecordId, sourceVariantKey, sourceExpansionId: evidence.sourceExpansionId });
      continue;
    }
    targetLanePriceable++;

    const sourceKey = pairKey(sourceRecordId, sourceVariantKey);
    const identityKey = pairKey(identity.id, sourceVariantKey);
    if (sourceOwner.has(sourceKey) && sourceOwner.get(sourceKey) !== identity.id) {
      addReason('target_source_finish_owned_by_other_identity', identity, { sourceRecordId, sourceVariantKey, existingCardIdentityId: sourceOwner.get(sourceKey) });
      continue;
    }
    if (canonicalOwner.has(identityKey) && canonicalOwner.get(identityKey) !== sourceRecordId) {
      addReason('target_identity_finish_owned_by_other_product', identity, { sourceRecordId, sourceVariantKey, existingSourceRecordId: canonicalOwner.get(identityKey) });
      continue;
    }

    candidates.push({
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
      sourceSetCode: evidence.sourceSetCode,
      priceLane,
      proof: {
        method: 'existing_exact_mappings_prove_single_cardmarket_expansion_then_exact_name_number_unique_product',
        existingMappedProductsInSet: evidence.mappedProducts,
        minimumRequiredMappedProducts: MIN_PROVEN_PRODUCTS,
      },
    });
  }

  const sourceBatchOwners = new Map();
  const canonicalBatchOwners = new Map();
  const conflictedSourceKeys = new Set();
  const conflictedCanonicalKeys = new Set();
  for (const row of candidates) {
    const sourceKey = pairKey(row.sourceRecordId, row.sourceVariantKey);
    const canonicalKey = pairKey(row.cardIdentityId, row.sourceVariantKey);
    const priorSource = sourceBatchOwners.get(sourceKey);
    const priorCanonical = canonicalBatchOwners.get(canonicalKey);
    if (priorSource && priorSource !== row.cardIdentityId) conflictedSourceKeys.add(sourceKey);
    else sourceBatchOwners.set(sourceKey, row.cardIdentityId);
    if (priorCanonical && priorCanonical !== row.sourceRecordId) conflictedCanonicalKeys.add(canonicalKey);
    else canonicalBatchOwners.set(canonicalKey, row.sourceRecordId);
  }
  const safeCandidates = candidates.filter((row) => !conflictedSourceKeys.has(pairKey(row.sourceRecordId, row.sourceVariantKey)) && !conflictedCanonicalKeys.has(pairKey(row.cardIdentityId, row.sourceVariantKey)));

  const bySet = {};
  for (const row of safeCandidates) {
    const current = bySet[row.setName] || { count: 0, sourceExpansionId: row.sourceExpansionId, sourceSetCode: row.sourceSetCode };
    current.count++;
    bySet[row.setName] = current;
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: { cardmarketCatalogueSha256: catalogueArtifact.sha256, cardmarketPriceGuideSha256: priceArtifact.sha256 },
    policy: { minExistingMappedProductsForDerivedExpansion: MIN_PROVEN_PRODUCTS, exactStructuredNameAndCollectorNumberRequired: true, singleExpansionRequired: true, singleSourceSetCodeRequired: true, meaningfulTargetFinishPriceLaneRequired: true },
    counts: {
      eligibleUnmappedNormalHolo: eligibleUnmapped,
      setsWithStrictDerivedExpansionEvidence: setEvidence.size,
      rejectedSetEvidence: rejectedSetEvidence.length,
      inProvenDerivedExpansion,
      exactUniqueProduct,
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
