import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

function positiveStoredPriceSql(alias = 'o') {
  return `GREATEST(
    COALESCE(${alias}.market_price,0),
    COALESCE(${alias}.trend_price,0),
    COALESCE(${alias}.avg_1d,0),
    COALESCE(${alias}.avg_7d,0),
    COALESCE(${alias}.avg_30d,0)
  ) > 0`;
}

function shape(variant) {
  return {
    type: variant?.type ?? null,
    subtype: variant?.subtype ?? null,
    foil: variant?.foil ?? null,
    stamp: Array.isArray(variant?.stamp) ? variant.stamp : [],
    cardmarketProductId: variant?.cardmarketProductId ?? null,
  };
}

function shapeKey(variant) {
  const v = shape(variant);
  return JSON.stringify([v.type, v.subtype, v.foil, v.stamp]);
}

function add(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

async function build(db) {
  const tcgdex = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of tcgdex.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows } = await db.query(`
    WITH residual AS (
      SELECT i.id AS card_identity_id,
             i.printing_id,
             i.set_id,
             p.name,
             p.collector_number,
             s.name AS set_name,
             MIN(cm.id) AS mapping_id,
             MIN(cm.source_record_id) AS source_record_id,
             COUNT(DISTINCT cm.source_record_id)::int AS product_count
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      JOIN fatedrop_card_source_mappings cm
        ON cm.card_identity_id=i.id
       AND cm.source_name='cardmarket'
       AND cm.source_variant_key='holo'
      WHERE i.verification_status='verified'
        AND i.language_code='en'
        AND i.variant_code='holo'
        AND NOT EXISTS (
          SELECT 1 FROM fatedrop_market_observations o
          WHERE o.card_identity_id=i.id
            AND o.source_name='cardmarket'
            AND ${positiveStoredPriceSql('o')}
        )
      GROUP BY i.id,i.printing_id,i.set_id,p.name,p.collector_number,s.name
      HAVING COUNT(DISTINCT cm.source_record_id)=1
    )
    SELECT r.*,
           array_agg(DISTINCT dx.source_record_id ORDER BY dx.source_record_id)
             FILTER (WHERE dx.source_record_id IS NOT NULL) AS tcgdex_card_ids
    FROM residual r
    LEFT JOIN fatedrop_card_source_mappings dx
      ON dx.card_identity_id=r.card_identity_id
     AND dx.source_name='tcgdex'
    GROUP BY r.card_identity_id,r.printing_id,r.set_id,r.name,r.collector_number,r.set_name,
             r.mapping_id,r.source_record_id,r.product_count
    ORDER BY r.set_name,r.collector_number,r.card_identity_id`);

  const counts = {
    singleMappedUnpricedHolo: rows.length,
    currentBaseLaneOnly: 0,
    oneTcgdexCardLink: 0,
    tcgdexCardFound: 0,
    exactProviderProductFound: 0,
    providerNameCompatible: 0,
    oneExplicitMatchingVariant: 0,
    sourceCardHasOneVariantTotal: 0,
    sourceCardHasMultipleVariants: 0,
    matchingVariantIsHolo: 0,
    matchingVariantIsNonHolo: 0,
    matchingVariantHasStamp: 0,
    matchingVariantHasNoStamp: 0,
    potentiallyExactSingleVariantHolo: 0,
  };
  const reasons = {};
  const shapeCounts = {};
  const exactSingleVariantHolo = [];
  const rowsOut = [];

  for (const row of rows) {
    const sourceRecordId = String(row.source_record_id);
    const priceRow = priceById.get(sourceRecordId) || null;
    const baseLane = Boolean(priceRow && hasMeaningfulCardmarketLane(priceRow, 'standard'));
    const holoLane = Boolean(priceRow && hasMeaningfulCardmarketLane(priceRow, 'holo'));
    if (!(baseLane && !holoLane)) continue;
    counts.currentBaseLaneOnly += 1;

    const out = {
      cardIdentityId: row.card_identity_id,
      mappingId: row.mapping_id,
      sourceRecordId,
      printingId: row.printing_id,
      setId: row.set_id,
      setName: row.set_name,
      name: row.name,
      collectorNumber: row.collector_number,
      baseLanePositive: baseLane,
      holoLanePositive: holoLane,
      tcgdexCardIds: row.tcgdex_card_ids || [],
    };

    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      add(reasons, 'tcgdex_card_link_not_unique');
      rowsOut.push({ ...out, classification: 'tcgdex_card_link_not_unique' });
      continue;
    }
    counts.oneTcgdexCardLink += 1;
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    if (!card) {
      add(reasons, 'tcgdex_card_missing');
      rowsOut.push({ ...out, tcgdexCardId, classification: 'tcgdex_card_missing' });
      continue;
    }
    counts.tcgdexCardFound += 1;

    const product = productById.get(sourceRecordId) || null;
    if (!product) {
      add(reasons, 'mapped_product_absent_from_current_catalogue');
      rowsOut.push({ ...out, tcgdexCardId, classification: 'mapped_product_absent_from_current_catalogue', variants: card.variants.map(shape) });
      continue;
    }
    counts.exactProviderProductFound += 1;
    const nameCompatible = rootProductNameMatches(row.name, product.name);
    if (!nameCompatible) {
      add(reasons, 'provider_name_conflict');
      rowsOut.push({ ...out, tcgdexCardId, providerName: product.name, classification: 'provider_name_conflict', variants: card.variants.map(shape) });
      continue;
    }
    counts.providerNameCompatible += 1;

    const matching = card.variants.filter((variant) => String(variant.cardmarketProductId ?? '') === sourceRecordId);
    if (matching.length !== 1) {
      add(reasons, matching.length === 0 ? 'no_explicit_variant_for_mapped_product' : 'multiple_variants_share_mapped_product');
      rowsOut.push({
        ...out,
        tcgdexCardId,
        providerName: product.name,
        classification: matching.length === 0 ? 'no_explicit_variant_for_mapped_product' : 'multiple_variants_share_mapped_product',
        variants: card.variants.map(shape),
        matchingVariants: matching.map(shape),
      });
      continue;
    }
    counts.oneExplicitMatchingVariant += 1;
    const [variant] = matching;
    const variantShape = shape(variant);
    add(shapeCounts, shapeKey(variant));
    if (card.variants.length === 1) counts.sourceCardHasOneVariantTotal += 1;
    else counts.sourceCardHasMultipleVariants += 1;
    if (variant.type === 'holo') counts.matchingVariantIsHolo += 1;
    else counts.matchingVariantIsNonHolo += 1;
    if (variantShape.stamp.length) counts.matchingVariantHasStamp += 1;
    else counts.matchingVariantHasNoStamp += 1;

    const exactSingle = card.variants.length === 1
      && variant.type === 'holo'
      && variantShape.stamp.length === 0;
    if (exactSingle) {
      counts.potentiallyExactSingleVariantHolo += 1;
      exactSingleVariantHolo.push({
        cardIdentityId: row.card_identity_id,
        mappingId: row.mapping_id,
        sourceRecordId,
        setName: row.set_name,
        name: row.name,
        collectorNumber: row.collector_number,
        tcgdexCardId,
        providerName: product.name,
        variant: variantShape,
      });
    }

    rowsOut.push({
      ...out,
      tcgdexCardId,
      providerName: product.name,
      classification: exactSingle ? 'single_source_variant_exact_holo_candidate' : 'explicit_variant_requires_stronger_review',
      sourceVariantCount: card.variants.length,
      matchingVariant: variantShape,
      variants: card.variants.map(shape),
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
    counts,
    reasons,
    matchingVariantShapes: Object.fromEntries(
      Object.entries(shapeCounts).sort((a, b) => b[1] - a[1]),
    ),
    exactSingleVariantHolo,
    rows: rowsOut,
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
    const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-residual-holo-evidence-audit.json`;
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      status: report.status,
      productionWrites: report.productionWrites,
      source: report.source,
      counts: report.counts,
      reasons: report.reasons,
      matchingVariantShapes: report.matchingVariantShapes,
      exactSingleVariantHolo: report.exactSingleVariantHolo?.slice(0, 25),
    }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
