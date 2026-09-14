import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const SET_NAME = 'Scarlet & Violet';
const SET_ID = 'sv01';
const POLICY = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});

const text = (value) => String(value ?? '').trim();
const key = (...parts) => parts.map(text).join('|');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function collector(value) {
  try { return normaliseCollectorNumber(text(value)); } catch { return null; }
}

function baselineVariant(variant) {
  return variant && !variant.subtype && !variant.foil && Array.isArray(variant.stamp) && variant.stamp.length === 0;
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
  const set = repo.bySetId.get(SET_ID);
  if (!set || set.setName !== SET_NAME) throw new Error('Pinned TCGdex Scarlet & Violet set not found');
  const expansionId = Number(set.cardmarketExpansionId);
  if (!Number.isSafeInteger(expansionId) || expansionId <= 0) throw new Error('Pinned TCGdex Scarlet & Violet set has no explicit Cardmarket expansion id');

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const cardById = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));

  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,s.id AS set_id,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE s.name=$1
      AND i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.card_identity_id=i.id AND m.source_name='cardmarket')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
    ORDER BY p.collector_number,i.variant_code,i.id`, [SET_NAME]);

  const { rows: ownerRows } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of ownerRows) {
    const sourceKey = key(row.source_record_id,row.source_variant_key);
    const ids = owners.get(sourceKey) || new Set();
    ids.add(row.card_identity_id);
    owners.set(sourceKey, ids);
  }

  const results = [];
  const reasons = {};
  const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };

  for (const row of rows) {
    const policy = POLICY[row.variant_code];
    const tcgdexIds = row.tcgdex_card_ids || [];
    let status;
    let card = null;
    let rootProductId = null;
    let product = null;
    let baseline = [];

    if (!policy) status = 'HOLD_UNSUPPORTED_FINISH';
    else if (tcgdexIds.length !== 1) status = 'HOLD_TCGDEX_LINK_COUNT';
    else {
      card = cardById.get(tcgdexIds[0]);
      if (!card) status = 'HOLD_TCGDEX_CARD_MISSING';
      else if (!rootProductNameMatches(row.name, card.name)) status = 'HOLD_TCGDEX_NAME_MISMATCH';
      else if (collector(row.collector_number) !== collector(card.localId)) status = 'HOLD_TCGDEX_COLLECTOR_MISMATCH';
      else {
        rootProductId = getRootCardmarketProductId(card);
        if (!rootProductId) status = 'HOLD_NO_ROOT_CARDMARKET_PRODUCT_ID';
        else {
          rootProductId = String(rootProductId);
          product = productById.get(rootProductId) || null;
          if (!product) status = 'HOLD_ROOT_PRODUCT_MISSING_FROM_CATALOGUE';
          else if (Number(product.sourceExpansionId) !== expansionId) status = 'HOLD_ROOT_PRODUCT_EXPANSION_MISMATCH';
          else if (!rootProductNameMatches(row.name, product.name)) status = 'HOLD_ROOT_PRODUCT_NAME_MISMATCH';
          else {
            baseline = (card.variants || []).filter(baselineVariant);
            const target = baseline.filter((variant) => variant.type === policy.tcgdexType);
            const other = baseline.filter((variant) => variant.type !== policy.tcgdexType);
            if (target.length !== 1) status = target.length === 0 ? 'HOLD_NO_BASELINE_TARGET_FINISH' : 'HOLD_MULTIPLE_BASELINE_TARGET_FINISHES';
            else if (other.length > 0) status = 'HOLD_ROOT_PRODUCT_NOT_FINISH_SPECIFIC';
            else if ((card.variants || []).some((variant) => !baselineVariant(variant))) status = 'HOLD_SPECIAL_VARIANTS_REQUIRE_SEPARATE_PRODUCT_PROOF';
            else {
              const sourceOwners = owners.get(key(rootProductId, policy.sourceVariantKey));
              if (sourceOwners?.size && !(sourceOwners.size === 1 && sourceOwners.has(row.id))) status = 'HOLD_PRODUCT_ALREADY_OWNED';
              else {
                const price = priceById.get(rootProductId);
                if (centralLane(price, policy.priceLane)) status = 'PRICEABLE_TARGET_LANE';
                else if (row.variant_code === 'holo' && centralLane(price, 'standard') && !centralLane(price, 'holo')) status = 'REVIEW_BASE_LANE_AFTER_SOLE_FINISH_PROOF';
                else status = 'PRICE_UNAVAILABLE';
              }
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
      status,
      method: status && !status.startsWith('HOLD_') ? 'pinned_tcgdex_root_product_plus_sole_baseline_finish' : null,
      sourceRecordId: rootProductId,
      sourceVariantKey: policy?.sourceVariantKey ?? null,
      priceLane: policy?.priceLane ?? null,
      cardmarketProductName: product?.name ?? null,
      baselineVariantTypes: baseline.map((variant) => variant.type),
      proposedMappingId: rootProductId && policy ? stableMappingId(row.id,rootProductId,policy.sourceVariantKey) : null,
    }));
  }

  const safeStatuses = new Set(['PRICEABLE_TARGET_LANE','REVIEW_BASE_LANE_AFTER_SOLE_FINISH_PROOF','PRICE_UNAVAILABLE']);
  const candidates = results.filter((row) => row.sourceRecordId && safeStatuses.has(row.status));
  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      tcgdexRevision: process.env.TCGDEX_REVISION,
      tcgdexSetId: SET_ID,
      cardmarketExpansionId: expansionId,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze({
      input: results.length,
      candidates: candidates.length,
      directlyPriceable: candidates.filter((row) => row.status === 'PRICEABLE_TARGET_LANE').length,
      baseLaneReview: candidates.filter((row) => row.status === 'REVIEW_BASE_LANE_AFTER_SOLE_FINISH_PROOF').length,
      priceUnavailable: candidates.filter((row) => row.status === 'PRICE_UNAVAILABLE').length,
      held: results.length - candidates.length,
      ownershipCollisions: results.filter((row) => row.status === 'HOLD_PRODUCT_ALREADY_OWNED').length,
    }),
    reasons: Object.freeze(reasons),
    cohortDigest: digest(results.map((row) => [row.cardIdentityId,row.variantCode,row.status,row.sourceRecordId])),
    candidateDigest: digest(candidates.map((row) => [row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.status])),
    candidates: Object.freeze(candidates),
    held: Object.freeze(results.filter((row) => !safeStatuses.has(row.status))),
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
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/sv-base-root-finish-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, reasons: report.reasons, cohortDigest: report.cohortDigest, candidateDigest: report.candidateDigest, error: report.error }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
