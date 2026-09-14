import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { getRootCardmarketProductId } from './cardmarket-tcgdex-root-evidence.mjs';

const SET_NAME = 'Scarlet & Violet';
const SET_ID = 'sv01';
const EXPANSION_ID = 5223;

// Narrow provider-name corroboration only. These suffixes are not stripped
// generically: each accepted label is pinned to its exact set collector slot.
const EXPECTED_PROVIDER_LABELS = Object.freeze(new Map([
  ['189', "Professor's Research - Professor Sada"],
  ['190', "Professor's Research - Professor Turo"],
  ['240', "Professor's Research - Professor Sada"],
  ['241', "Professor's Research - Professor Turo"],
]));

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (...parts) => parts.map((part) => String(part ?? '').trim()).join('|');
function collector(value) { return normaliseCollectorNumber(String(value ?? '').trim()); }
function baselineVariant(variant) {
  return variant && !variant.subtype && !variant.foil && Array.isArray(variant.stamp) && variant.stamp.length === 0;
}
function centralLane(row, lane) {
  const fields = lane === 'holo'
    ? ['trend-holo','avg1-holo','avg7-holo','avg30-holo']
    : ['trend','avg1','avg7','avg30'];
  return fields.some((field) => Number(row?.[field]) > 0);
}
function stableMappingId(identityId, productId) {
  return `fdcardmap_${createHash('sha256').update(`${identityId}|cardmarket|${productId}|holo`).digest('hex').slice(0, 24)}`;
}

export async function build(db, { repoEvidence, sources } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const set = repo.bySetId.get(SET_ID);
  if (!set || set.setName !== SET_NAME || Number(set.cardmarketExpansionId) !== EXPANSION_ID) throw new Error('Pinned Scarlet & Violet set evidence changed');
  const cardById = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows } = await db.query(`
    SELECT i.id,i.set_id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
      rs.classifier_state,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE s.name=$1 AND p.collector_number=ANY($2::text[])
      AND i.verification_status='verified' AND i.language_code='en' AND i.variant_code='holo'
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.card_identity_id=i.id AND m.source_name='cardmarket')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
    ORDER BY p.collector_number`, [SET_NAME,[...EXPECTED_PROVIDER_LABELS.keys()]]);

  const { rows: ownerRows } = await db.query(`SELECT card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of ownerRows) {
    const k = key(row.source_record_id,row.source_variant_key);
    const ids = owners.get(k) || new Set();
    ids.add(row.card_identity_id);
    owners.set(k,ids);
  }

  const results = [];
  for (const row of rows) {
    const expectedLabel = EXPECTED_PROVIDER_LABELS.get(String(row.collector_number));
    const tcgdexIds = row.tcgdex_card_ids || [];
    let status;
    let sourceRecordId = null;
    let product = null;
    if (row.name !== "Professor's Research") status = 'HOLD_CANONICAL_NAME_CHANGED';
    else if (tcgdexIds.length !== 1) status = 'HOLD_TCGDEX_LINK_COUNT';
    else {
      const card = cardById.get(tcgdexIds[0]);
      if (!card) status = 'HOLD_TCGDEX_CARD_MISSING';
      else if (card.name !== "Professor's Research") status = 'HOLD_TCGDEX_NAME_CHANGED';
      else if (collector(card.localId) !== collector(row.collector_number)) status = 'HOLD_TCGDEX_COLLECTOR_MISMATCH';
      else {
        sourceRecordId = String(getRootCardmarketProductId(card) || '');
        if (!sourceRecordId) status = 'HOLD_NO_ROOT_PRODUCT_ID';
        else {
          product = productById.get(sourceRecordId) || null;
          if (!product) status = 'HOLD_ROOT_PRODUCT_MISSING';
          else if (Number(product.sourceExpansionId) !== EXPANSION_ID) status = 'HOLD_ROOT_PRODUCT_EXPANSION_MISMATCH';
          else if (product.name !== expectedLabel) status = 'HOLD_PROVIDER_LABEL_MISMATCH';
          else {
            const baseline = (card.variants || []).filter(baselineVariant);
            const target = baseline.filter((variant) => variant.type === 'holo');
            const other = baseline.filter((variant) => variant.type !== 'holo');
            if (target.length !== 1 || other.length !== 0 || (card.variants || []).some((variant) => !baselineVariant(variant))) status = 'HOLD_FINISH_NOT_SOLE_ORDINARY_HOLO';
            else {
              const sourceOwners = owners.get(key(sourceRecordId,'holo'));
              if (sourceOwners?.size && !(sourceOwners.size === 1 && sourceOwners.has(row.id))) status = 'HOLD_PRODUCT_ALREADY_OWNED';
              else {
                const price = priceById.get(sourceRecordId);
                if (centralLane(price,'holo')) status = 'PRICEABLE_HOLO_LANE';
                else if (centralLane(price,'standard')) status = 'REVIEW_BASE_LANE_AFTER_SOLE_FINISH_PROOF';
                else status = 'PRICE_UNAVAILABLE';
              }
            }
          }
        }
      }
    }
    results.push(Object.freeze({
      cardIdentityId: row.id,
      setId: row.set_id,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
      tcgdexCardId: tcgdexIds.length === 1 ? tcgdexIds[0] : null,
      sourceRecordId,
      sourceVariantKey: 'holo',
      priceLane: status === 'PRICEABLE_HOLO_LANE' ? 'holo' : status === 'REVIEW_BASE_LANE_AFTER_SOLE_FINISH_PROOF' ? 'standard-as-reviewed-holo' : null,
      cardmarketProductName: product?.name ?? null,
      expectedProviderLabel: expectedLabel,
      status,
      proposedMappingId: sourceRecordId ? stableMappingId(row.id,sourceRecordId) : null,
      proof: 'exact_tcgdex_card_root_product_plus_collector_pinned_provider_label_plus_sole_ordinary_holo_finish',
    }));
  }

  if (results.length !== EXPECTED_PROVIDER_LABELS.size) throw new Error(`Expected 4 Professor's Research residual identities, found ${results.length}`);
  const safe = new Set(['PRICEABLE_HOLO_LANE','REVIEW_BASE_LANE_AFTER_SOLE_FINISH_PROOF','PRICE_UNAVAILABLE']);
  const candidates = results.filter((row) => safe.has(row.status));
  const reasons = {};
  for (const row of results) reasons[row.status] = (reasons[row.status] || 0) + 1;

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({ tcgdexRevision: process.env.TCGDEX_REVISION, tcgdexSetId: SET_ID, cardmarketExpansionId: EXPANSION_ID, cardmarketCatalogueSha256: catalogue.sha256, cardmarketPriceGuideSha256: guide.sha256, sourceSnapshotId: snapshot.sourceSnapshotId }),
    counts: Object.freeze({ input: results.length, candidates: candidates.length, directlyPriceable: candidates.filter((r) => r.status === 'PRICEABLE_HOLO_LANE').length, baseLaneReview: candidates.filter((r) => r.status === 'REVIEW_BASE_LANE_AFTER_SOLE_FINISH_PROOF').length, priceUnavailable: candidates.filter((r) => r.status === 'PRICE_UNAVAILABLE').length, held: results.length - candidates.length, ownershipCollisions: results.filter((r) => r.status === 'HOLD_PRODUCT_ALREADY_OWNED').length }),
    reasons: Object.freeze(reasons),
    candidateDigest: digest(candidates.map((r) => [r.cardIdentityId,r.collectorNumber,r.sourceRecordId,r.cardmarketProductName,r.status])),
    candidates: Object.freeze(candidates),
    held: Object.freeze(results.filter((r) => !safe.has(r.status))),
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
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/sv-base-professors-research-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, reasons: report.reasons, candidateDigest: report.candidateDigest, error: report.error }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
