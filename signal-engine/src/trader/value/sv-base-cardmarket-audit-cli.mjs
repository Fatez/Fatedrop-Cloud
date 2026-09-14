import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const SET_NAME = 'Scarlet & Violet';
const POLICY = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});

const key = (...parts) => parts.map((part) => String(part ?? '').trim()).join('|');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function collector(value) {
  try { return normaliseCollectorNumber(String(value ?? '').trim()); } catch { return null; }
}

function isBaseline(variant, type) {
  return variant?.type === type
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0;
}

function centralLane(row, lane) {
  const fields = lane === 'holo'
    ? ['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']
    : ['trend', 'avg1', 'avg7', 'avg30'];
  return fields.some((field) => Number(row?.[field]) > 0);
}

function stableMappingId(identityId, productId, variantKey) {
  return `fdcardmap_${createHash('sha256').update(`${identityId}|cardmarket|${productId}|${variantKey}`).digest('hex').slice(0, 24)}`;
}

export async function build(db, { repoEvidence, sources } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const matchingSets = repo.sets.filter((set) => set.setName === SET_NAME);
  if (matchingSets.length !== 1) throw new Error(`Expected exactly one pinned TCGdex ${SET_NAME} set, found ${matchingSets.length}`);
  const set = matchingSets[0];
  const expansionId = Number(set.cardmarketExpansionId);
  if (!Number.isSafeInteger(expansionId) || expansionId <= 0) throw new Error('Pinned TCGdex Scarlet & Violet set has no explicit Cardmarket expansion id');

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const cards = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));

  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,s.id AS set_id,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids,
      ARRAY(SELECT m.source_record_id || ':' || COALESCE(m.source_variant_key,'') FROM fatedrop_card_source_mappings m
        WHERE m.card_identity_id=i.id AND m.source_name='cardmarket' ORDER BY m.source_record_id,m.source_variant_key) AS cardmarket_mappings
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE s.name=$1
      AND i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
    ORDER BY p.collector_number,i.variant_code,i.id`, [SET_NAME]);

  const { rows: ownerRows } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of ownerRows) {
    const k = key(row.source_record_id,row.source_variant_key);
    const ids = owners.get(k) || new Set();
    ids.add(row.card_identity_id);
    owners.set(k, ids);
  }

  const results = [];
  const reasons = {};
  const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };

  for (const row of rows) {
    const policy = POLICY[row.variant_code];
    const tcgdexIds = row.tcgdex_card_ids || [];
    const existing = row.cardmarket_mappings || [];
    let status;
    let sourceRecordId = null;
    let product = null;
    let baselineIds = [];
    let method = null;

    if (!policy) status = 'HOLD_UNSUPPORTED_FINISH';
    else if (tcgdexIds.length !== 1) status = 'HOLD_TCGDEX_LINK_COUNT';
    else {
      const card = cards.get(tcgdexIds[0]);
      if (!card) status = 'HOLD_TCGDEX_CARD_MISSING';
      else if (!rootProductNameMatches(row.name, card.name)) status = 'HOLD_TCGDEX_NAME_MISMATCH';
      else if (collector(row.collector_number) !== collector(card.localId)) status = 'HOLD_TCGDEX_COLLECTOR_MISMATCH';
      else {
        baselineIds = [...new Set((card.variants || [])
          .filter((variant) => isBaseline(variant, policy.tcgdexType))
          .map((variant) => Number(variant.cardmarketProductId))
          .filter((value) => Number.isSafeInteger(value) && value > 0))]
          .map(String);
        if (existing.length > 0) {
          if (existing.length !== 1) status = 'HOLD_MULTIPLE_EXISTING_CARDMARKET_MAPPINGS';
          else {
            const [mappedProductId,mappedVariantKey] = existing[0].split(':');
            if (mappedVariantKey !== policy.sourceVariantKey) status = 'HOLD_EXISTING_MAPPING_FINISH_MISMATCH';
            else {
              sourceRecordId = mappedProductId;
              product = productById.get(sourceRecordId) || null;
              if (!product) status = 'HOLD_MAPPED_PRODUCT_MISSING_FROM_CATALOGUE';
              else if (Number(product.sourceExpansionId) !== expansionId) status = 'HOLD_MAPPED_PRODUCT_EXPANSION_MISMATCH';
              else if (!rootProductNameMatches(row.name, product.name)) status = 'HOLD_MAPPED_PRODUCT_NAME_MISMATCH';
              else {
                method = 'existing_exact_mapping_revalidated';
                const price = priceById.get(sourceRecordId);
                if (centralLane(price, policy.priceLane)) status = 'PRICEABLE_TARGET_LANE';
                else if (row.variant_code === 'holo' && centralLane(price, 'standard') && !centralLane(price, 'holo')) status = 'REVIEW_BASE_LANE';
                else status = 'PRICE_UNAVAILABLE';
              }
            }
          }
        } else if (baselineIds.length === 0) status = 'HOLD_NO_EXPLICIT_BASELINE_TARGET_PRODUCT_ID';
        else if (baselineIds.length > 1) status = 'HOLD_MULTIPLE_BASELINE_TARGET_PRODUCT_IDS';
        else {
          sourceRecordId = baselineIds[0];
          product = productById.get(sourceRecordId) || null;
          if (!product) status = 'HOLD_EXPLICIT_PRODUCT_MISSING_FROM_CATALOGUE';
          else if (Number(product.sourceExpansionId) !== expansionId) status = 'HOLD_EXPLICIT_PRODUCT_EXPANSION_MISMATCH';
          else if (!rootProductNameMatches(row.name, product.name)) status = 'HOLD_EXPLICIT_PRODUCT_NAME_MISMATCH';
          else {
            const sourceOwners = owners.get(key(sourceRecordId, policy.sourceVariantKey));
            if (sourceOwners?.size && !(sourceOwners.size === 1 && sourceOwners.has(row.id))) status = 'HOLD_PRODUCT_ALREADY_OWNED';
            else {
              method = 'pinned_tcgdex_unique_unstamped_exact_finish_product_id';
              const price = priceById.get(sourceRecordId);
              if (centralLane(price, policy.priceLane)) status = 'PRICEABLE_TARGET_LANE';
              else if (row.variant_code === 'holo' && centralLane(price, 'standard') && !centralLane(price, 'holo')) status = 'REVIEW_BASE_LANE';
              else status = 'PRICE_UNAVAILABLE';
            }
          }
        }
      }
    }

    bump(status);
    results.push(Object.freeze({
      cardIdentityId: row.id,
      setId: row.set_id,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
      tcgdexCardId: tcgdexIds.length === 1 ? tcgdexIds[0] : null,
      existingCardmarketMappings: existing,
      status,
      method,
      sourceRecordId,
      sourceVariantKey: policy?.sourceVariantKey ?? null,
      priceLane: policy?.priceLane ?? null,
      cardmarketProductName: product?.name ?? null,
      baselineExplicitProductIds: baselineIds,
      proposedMappingId: sourceRecordId && policy ? stableMappingId(row.id,sourceRecordId,policy.sourceVariantKey) : null,
    }));
  }

  const unmapped = results.filter((row) => row.existingCardmarketMappings.length === 0);
  const mapped = results.filter((row) => row.existingCardmarketMappings.length > 0);
  const candidateStatuses = new Set(['PRICEABLE_TARGET_LANE','REVIEW_BASE_LANE','PRICE_UNAVAILABLE']);
  const mappingCandidates = unmapped.filter((row) => row.sourceRecordId && candidateStatuses.has(row.status));
  const directlyPriceable = results.filter((row) => row.status === 'PRICEABLE_TARGET_LANE');
  const baseLaneReview = results.filter((row) => row.status === 'REVIEW_BASE_LANE');
  const priceUnavailable = results.filter((row) => row.status === 'PRICE_UNAVAILABLE');

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      tcgdexRevision: process.env.TCGDEX_REVISION,
      tcgdexSetId: set.tcgdexSetId,
      cardmarketExpansionId: expansionId,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze({
      residual: results.length,
      unmapped: unmapped.length,
      mappedUnpriced: mapped.length,
      mappingCandidates: mappingCandidates.length,
      directlyPriceable: directlyPriceable.length,
      baseLaneReview: baseLaneReview.length,
      priceUnavailable: priceUnavailable.length,
      held: results.length - mappingCandidates.length - priceUnavailable.filter((row) => row.existingCardmarketMappings.length > 0).length,
    }),
    reasons: Object.freeze(reasons),
    cohortDigest: digest(results.map((row) => [row.cardIdentityId,row.variantCode,row.status,row.sourceRecordId])),
    candidateDigest: digest(mappingCandidates.map((row) => [row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.status])),
    mappingCandidates: Object.freeze(mappingCandidates),
    directlyPriceable: Object.freeze(directlyPriceable),
    baseLaneReview: Object.freeze(baseLaneReview),
    priceUnavailable: Object.freeze(priceUnavailable),
    held: Object.freeze(results.filter((row) => !candidateStatuses.has(row.status))),
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  let report;
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    report = await build(db);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/sv-base-cardmarket-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, reasons: report.reasons, cohortDigest: report.cohortDigest, candidateDigest: report.candidateDigest, error: report.error }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
