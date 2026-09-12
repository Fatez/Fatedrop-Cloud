import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

function isBaseline(variant, type) {
  return variant?.type === type
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0;
}

async function build(db) {
  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows } = await db.query(`
    WITH positively_priced AS (
      SELECT DISTINCT card_identity_id
      FROM fatedrop_market_observations
      WHERE source_name='cardmarket'
        AND GREATEST(
          COALESCE(market_price,0),COALESCE(low_price,0),COALESCE(trend_price,0),
          COALESCE(avg_1d,0),COALESCE(avg_7d,0),COALESCE(avg_30d,0),
          COALESCE(avg_lifetime,0),COALESCE(excellent_plus_low,0)
        ) > 0
    )
    SELECT i.id, p.name, p.collector_number, s.name AS set_name,
           array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) AS tcgdex_card_ids,
           array_agg(cm.id ORDER BY cm.id) FILTER (WHERE cm.source_variant_key='holo') AS holo_mapping_ids,
           array_agg(cm.source_record_id ORDER BY cm.id) FILTER (WHERE cm.source_variant_key='holo') AS holo_product_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    JOIN fatedrop_card_source_mappings cm ON cm.card_identity_id=i.id AND cm.source_name='cardmarket'
    LEFT JOIN positively_priced priced ON priced.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code='holo'
      AND priced.card_identity_id IS NULL
    GROUP BY i.id,p.name,p.collector_number,s.name
    ORDER BY s.name,p.collector_number,i.id`);

  const { rows: normalMappings } = await db.query(`
    SELECT DISTINCT source_record_id
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket' AND source_variant_key='normal'`);
  const normalMappedProductIds = new Set(normalMappings.map((row) => String(row.source_record_id)));

  const counts = {
    mappedUnpricedHolo: rows.length,
    singleTcgdexLink: 0,
    exactlyOneHoloMapping: 0,
    productExists: 0,
    nameCompatible: 0,
    guideRowExists: 0,
    holoLaneEmpty: 0,
    standardLaneMeaningful: 0,
    baseLaneUnclaimedByNormalMapping: 0,
    baselineHoloPresent: 0,
    noNormalVariantAtAll: 0,
    strongExactProductEvidence: 0,
    safeBaseLaneCandidates: 0,
  };
  const reasons = {};
  const candidates = [];
  const reason = (name) => { reasons[name] = (reasons[name] || 0) + 1; };

  for (const row of rows) {
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      reason('multiple_tcgdex_card_links');
      continue;
    }
    counts.singleTcgdexLink += 1;
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    if (!card) { reason('tcgdex_card_missing'); continue; }

    const mappingIds = Array.isArray(row.holo_mapping_ids) ? row.holo_mapping_ids : [];
    const productIds = Array.isArray(row.holo_product_ids) ? row.holo_product_ids.map(String) : [];
    if (mappingIds.length !== 1 || productIds.length !== 1) {
      reason('not_exactly_one_holo_source_mapping');
      continue;
    }
    counts.exactlyOneHoloMapping += 1;
    const mappingId = mappingIds[0];
    const sourceRecordId = productIds[0];

    const product = productById.get(sourceRecordId);
    if (!product) { reason('mapped_product_absent_from_official_catalogue'); continue; }
    counts.productExists += 1;
    if (!rootProductNameMatches(row.name, product.name)) {
      reason('mapped_product_name_conflict');
      continue;
    }
    counts.nameCompatible += 1;

    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow) { reason('mapped_product_absent_from_current_price_guide'); continue; }
    counts.guideRowExists += 1;
    if (hasMeaningfulCardmarketLane(priceRow, 'holo')) {
      reason('provider_holo_lane_is_meaningful');
      continue;
    }
    counts.holoLaneEmpty += 1;
    if (!hasMeaningfulCardmarketLane(priceRow, 'standard')) {
      reason('provider_standard_lane_not_meaningful');
      continue;
    }
    counts.standardLaneMeaningful += 1;

    if (normalMappedProductIds.has(sourceRecordId)) {
      reason('provider_base_lane_claimed_by_normal_mapping');
      continue;
    }
    counts.baseLaneUnclaimedByNormalMapping += 1;

    const variants = Array.isArray(card.variants) ? card.variants : [];
    const baselineHolo = variants.filter((variant) => isBaseline(variant, 'holo'));
    if (baselineHolo.length === 0) {
      reason('no_baseline_holo_variant');
      continue;
    }
    counts.baselineHoloPresent += 1;

    if (variants.some((variant) => variant?.type === 'normal')) {
      reason('tcgdex_has_normal_variant');
      continue;
    }
    counts.noNormalVariantAtAll += 1;

    const explicitHoloIds = [...new Set(
      baselineHolo
        .map((variant) => Number(variant.cardmarketProductId))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    )].map(String);
    if (explicitHoloIds.length > 1) {
      reason('multiple_explicit_baseline_holo_product_ids');
      continue;
    }
    if (explicitHoloIds.length === 1 && explicitHoloIds[0] !== sourceRecordId) {
      reason('explicit_baseline_holo_product_disagrees_with_mapping');
      continue;
    }

    const rootId = getRootCardmarketProductId(card);
    if (rootId && String(rootId) !== sourceRecordId) {
      reason('root_product_disagrees_with_mapping');
      continue;
    }
    const evidenceBasis = explicitHoloIds.length === 1
      ? 'explicit_baseline_holo_product_id'
      : rootId && String(rootId) === sourceRecordId
        ? 'root_product_id_plus_holo_only_variant_structure'
        : null;
    if (!evidenceBasis) {
      reason('no_strong_exact_product_evidence');
      continue;
    }
    counts.strongExactProductEvidence += 1;

    candidates.push({
      cardIdentityId: row.id,
      setName: row.set_name,
      name: row.name,
      collectorNumber: row.collector_number,
      tcgdexCardId,
      mappingId,
      sourceRecordId,
      cardmarketProductName: product.name,
      evidenceBasis,
      baselineHoloVariantCount: baselineHolo.length,
      explicitBaselineHoloProductIds: explicitHoloIds,
      rootProductId: rootId || null,
      providerLane: {
        canonicalVariant: 'holo',
        sourceVariantKey: 'holo',
        requestedPriceLane: 'standard',
        holoLaneMeaningful: false,
        standardLaneMeaningful: true,
        normalMappingClaimsBaseLane: false,
      },
    });
  }

  counts.safeBaseLaneCandidates = candidates.length;
  const bySet = {};
  for (const row of candidates) bySet[row.setName] = (bySet[row.setName] || 0) + 1;

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
    },
    policy: {
      canonicalIdentityRemainsHolo: true,
      existingExactHoloMappingRequired: true,
      providerHoloLaneMustBeEmpty: true,
      providerStandardLaneMustBeMeaningful: true,
      providerBaseLaneMustNotHaveNormalMappingOwner: true,
      baselineHoloRequired: true,
      anyTcgdexNormalVariantDisqualifies: true,
      explicitBaselineHoloOrMatchingRootProductEvidenceRequired: true,
      reverseStampedAndSpecialFoilSubstitutionForbidden: true,
      noProductionWrites: true,
    },
    counts,
    reasons,
    bySet,
    candidates,
  };
}

async function main() {
  if (process.env.MAPPING_WRITE === 'true' || process.env.PRICE_WRITE === 'true') {
    throw new Error('This audit is read-only');
  }
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-inherent-holo-base-lane-audit.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, counts: report.counts, reasons: report.reasons, bySet: report.bySet, samples: report.candidates?.slice(0, 30) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
