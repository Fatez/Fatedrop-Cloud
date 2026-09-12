import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const TARGET_TYPE = Object.freeze({ standard: 'normal', holo: 'holo' });
const TARGET_SOURCE_VARIANT = Object.freeze({ standard: 'normal', holo: 'holo' });
const TARGET_PRICE_LANE = Object.freeze({ standard: 'standard', holo: 'holo' });

function positiveStoredPriceSql(alias = 'o') {
  return `GREATEST(
    COALESCE(${alias}.market_price,0),
    COALESCE(${alias}.trend_price,0),
    COALESCE(${alias}.avg_1d,0),
    COALESCE(${alias}.avg_7d,0),
    COALESCE(${alias}.avg_30d,0)
  ) > 0`;
}

function isUnstampedBaseline(variant, targetType) {
  return variant?.type === targetType
    && (variant.subtype == null || variant.subtype === '')
    && (variant.foil == null || variant.foil === '')
    && Array.isArray(variant.stamp)
    && variant.stamp.length === 0
    && Number.isSafeInteger(Number(variant.cardmarketProductId))
    && Number(variant.cardmarketProductId) > 0;
}

function addReason(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

export async function build(db, { repoEvidence, sources } = {}) {
  const tcgdex = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const tcgdexCardById = new Map();
  for (const set of tcgdex.sets) for (const card of set.cards) tcgdexCardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    (sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue()),
    (sources?.guide ?? fetchCardmarketPokemonPriceGuide()),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows } = await db.query(`
    WITH target_mappings AS (
      SELECT i.id AS card_identity_id,
             i.printing_id,
             i.set_id,
             i.variant_code,
             p.name,
             p.collector_number,
             s.name AS set_name,
             array_agg(DISTINCT cm.source_record_id ORDER BY cm.source_record_id) AS mapped_product_ids,
             array_agg(DISTINCT cm.id ORDER BY cm.id) AS mapping_ids,
             COUNT(DISTINCT cm.source_record_id)::int AS mapped_product_count
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      JOIN fatedrop_card_source_mappings cm
        ON cm.card_identity_id=i.id
       AND cm.source_name='cardmarket'
       AND cm.source_variant_key=CASE WHEN i.variant_code='standard' THEN 'normal' ELSE 'holo' END
      WHERE i.verification_status='verified'
        AND i.language_code='en'
        AND i.variant_code IN ('standard','holo')
        AND NOT EXISTS (
          SELECT 1 FROM fatedrop_market_observations o
          WHERE o.card_identity_id=i.id
            AND o.source_name='cardmarket'
            AND ${positiveStoredPriceSql('o')}
        )
      GROUP BY i.id,i.printing_id,i.set_id,i.variant_code,p.name,p.collector_number,s.name
      HAVING COUNT(DISTINCT cm.source_record_id) > 1
    )
    SELECT t.*,
           array_agg(DISTINCT dx.source_record_id ORDER BY dx.source_record_id)
             FILTER (WHERE dx.source_record_id IS NOT NULL) AS tcgdex_card_ids
    FROM target_mappings t
    LEFT JOIN fatedrop_card_source_mappings dx
      ON dx.card_identity_id=t.card_identity_id
     AND dx.source_name='tcgdex'
    GROUP BY t.card_identity_id,t.printing_id,t.set_id,t.variant_code,t.name,t.collector_number,
             t.set_name,t.mapped_product_ids,t.mapping_ids,t.mapped_product_count
    ORDER BY t.set_name,t.collector_number,t.card_identity_id`);

  const counts = {
    duplicateMappedUnpricedIdentities: rows.length,
    singleTcgdexCardLink: 0,
    tcgdexCardFound: 0,
    exactBaselineTargetVariant: 0,
    oneDistinctExplicitBaselineProduct: 0,
    desiredProductAlreadyMapped: 0,
    officialProductExists: 0,
    providerNameCompatible: 0,
    safeUniqueRetireCandidates: 0,
    desiredTargetLanePriceable: 0,
    desiredBaseLanePriceableForHolo: 0,
  };
  const reasons = {};
  const candidates = [];
  const held = [];

  for (const row of rows) {
    const mappedProductIds = (row.mapped_product_ids || []).map(String);
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      addReason(reasons, 'tcgdex_card_link_not_unique');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'tcgdex_card_link_not_unique', mappedProductIds });
      continue;
    }
    counts.singleTcgdexCardLink += 1;
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = tcgdexCardById.get(tcgdexCardId);
    if (!card) {
      addReason(reasons, 'tcgdex_card_evidence_missing');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'tcgdex_card_evidence_missing', tcgdexCardId, mappedProductIds });
      continue;
    }
    counts.tcgdexCardFound += 1;

    const targetType = TARGET_TYPE[row.variant_code];
    const baseline = card.variants.filter((variant) => isUnstampedBaseline(variant, targetType));
    if (baseline.length === 0) {
      addReason(reasons, 'no_unstamped_baseline_target_variant');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'no_unstamped_baseline_target_variant', tcgdexCardId, mappedProductIds, variants: card.variants });
      continue;
    }
    counts.exactBaselineTargetVariant += 1;

    const explicitIds = [...new Set(baseline.map((variant) => String(variant.cardmarketProductId)))];
    if (explicitIds.length !== 1) {
      addReason(reasons, 'baseline_target_variant_has_multiple_product_ids');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'baseline_target_variant_has_multiple_product_ids', tcgdexCardId, mappedProductIds, baselineVariants: baseline });
      continue;
    }
    counts.oneDistinctExplicitBaselineProduct += 1;
    const desiredProductId = explicitIds[0];

    if (!mappedProductIds.includes(desiredProductId)) {
      addReason(reasons, 'explicit_baseline_product_not_among_current_mappings');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'explicit_baseline_product_not_among_current_mappings', tcgdexCardId, mappedProductIds, desiredProductId, baselineVariants: baseline });
      continue;
    }
    counts.desiredProductAlreadyMapped += 1;

    const product = productById.get(desiredProductId);
    if (!product) {
      addReason(reasons, 'explicit_baseline_product_absent_from_official_catalogue');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'explicit_baseline_product_absent_from_official_catalogue', tcgdexCardId, mappedProductIds, desiredProductId });
      continue;
    }
    counts.officialProductExists += 1;

    if (!rootProductNameMatches(row.name, product.name)) {
      addReason(reasons, 'provider_product_name_conflict');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'provider_product_name_conflict', tcgdexCardId, mappedProductIds, desiredProductId, canonicalName: row.name, providerName: product.name });
      continue;
    }
    counts.providerNameCompatible += 1;

    const sourceVariantKey = TARGET_SOURCE_VARIANT[row.variant_code];
    const targetLane = TARGET_PRICE_LANE[row.variant_code];
    const priceRow = priceById.get(desiredProductId) || null;
    const targetLanePriceable = Boolean(priceRow && hasMeaningfulCardmarketLane(priceRow, targetLane));
    const baseLanePriceableForHolo = Boolean(row.variant_code === 'holo' && priceRow && hasMeaningfulCardmarketLane(priceRow, 'standard'));
    if (targetLanePriceable) counts.desiredTargetLanePriceable += 1;
    if (baseLanePriceableForHolo) counts.desiredBaseLanePriceableForHolo += 1;

    const staleProductIds = mappedProductIds.filter((id) => id !== desiredProductId);
    if (!staleProductIds.length) {
      addReason(reasons, 'no_stale_mapping_after_selection');
      held.push({ cardIdentityId: row.card_identity_id, reason: 'no_stale_mapping_after_selection', tcgdexCardId, mappedProductIds, desiredProductId });
      continue;
    }

    counts.safeUniqueRetireCandidates += 1;
    candidates.push({
      cardIdentityId: row.card_identity_id,
      printingId: row.printing_id,
      setId: row.set_id,
      setName: row.set_name,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
      tcgdexCardId,
      sourceVariantKey,
      targetLane,
      mappedProductIds,
      desiredProductId,
      desiredProductName: product.name,
      staleProductIds,
      targetLanePriceable,
      baseLanePriceableForHolo,
      proof: {
        method: 'single_pinned_tcgdex_card_plus_single_unstamped_baseline_target_finish_explicit_cardmarket_id',
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        baselineVariants: baseline,
      },
    });
  }

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      cardmarketSourceSnapshotId: snapshot.sourceSnapshotId,
    },
    policy: {
      scopeOnlyMappedUnpricedDuplicateTargetFinish: true,
      oneTcgdexCardLinkRequired: true,
      exactUnstampedBaselineTargetFinishRequired: true,
      oneExplicitBaselineProductIdRequired: true,
      desiredProductMustAlreadyBeMappedToSameIdentity: true,
      officialCurrentProductRequired: true,
      providerNameCompatibilityRequired: true,
      reverseExcluded: true,
      writesPerformed: false,
    },
    counts,
    reasons,
    candidates,
    held,
  };
}

async function main() {
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
    const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-residual-duplicate-mapping-audit.json`;
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      status: report.status,
      productionWrites: report.productionWrites,
      source: report.source,
      counts: report.counts,
      reasons: report.reasons,
      candidates: report.candidates?.slice(0, 25),
    }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
