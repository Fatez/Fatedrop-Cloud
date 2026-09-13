import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { buildEnglishPricingScope } from './english-pricing-bundle.mjs';

function positiveStoredPriceSql(alias = 'o') {
  return `GREATEST(COALESCE(${alias}.market_price,0),COALESCE(${alias}.trend_price,0),COALESCE(${alias}.avg_1d,0),COALESCE(${alias}.avg_7d,0),COALESCE(${alias}.avg_30d,0)) > 0`;
}

async function main() {
  if (['MAPPING_WRITE','PRICE_WRITE','CORRECTION_WRITE'].some((key) => process.env[key] === 'true')) {
    throw new Error('URL evidence input export is read-only');
  }
  validateProductionTarget(process.env.DATABASE_URL);
  const output = path.resolve(process.env.URL_EVIDENCE_EXPORT_OUTPUT || path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-user-url-input-export'));
  await mkdir(output, { recursive: true });
  const [catalogue, guide] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: sourceIdentities } = await db.query(`
      SELECT i.id,i.set_id,i.variant_code,i.language_code,i.verification_status,
             p.name,p.collector_number,s.name AS set_name,rs.classifier_state
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      WHERE i.language_code='en' AND i.verification_status='verified'
        AND i.variant_code IN ('standard','holo')
      ORDER BY i.id`);
    const scope = buildEnglishPricingScope(sourceIdentities);
    const eligibleIds = new Set(scope.eligibleCards.map((row) => row.id));
    const { rows: pricedRows } = await db.query(`
      SELECT DISTINCT card_identity_id
      FROM fatedrop_market_observations o
      WHERE o.source_name='cardmarket' AND ${positiveStoredPriceSql('o')}
      ORDER BY card_identity_id`);
    const priced = new Set(pricedRows.map((row) => row.card_identity_id).filter((id) => eligibleIds.has(id)));
    const { rows: mappings } = await db.query(`
      SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,
             i.set_id,i.variant_code,p.name,p.collector_number,s.name AS set_name
      FROM fatedrop_card_source_mappings m
      JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_sets s ON s.id=i.set_id
      WHERE m.source_name='cardmarket' AND i.verification_status='verified' AND i.language_code='en'
      ORDER BY m.card_identity_id,m.source_variant_key,m.source_record_id`);
    const mappedIds = new Set(mappings.filter((row) => eligibleIds.has(row.card_identity_id)).map((row) => row.card_identity_id));
    const backlog = scope.eligibleCards.filter((row) => !priced.has(row.id)).map((row) => ({
      cardIdentityId: row.id,
      setId: row.set_id,
      setName: row.set_name,
      cardName: row.name,
      collectorNumber: row.collector_number,
      finish: row.variant_code,
      queueSection: mappedIds.has(row.id) ? 'A' : 'B',
      mappings: mappings.filter((m) => m.card_identity_id === row.id).map((m) => ({
        id: m.id,
        sourceRecordId: String(m.source_record_id),
        sourceVariantKey: m.source_variant_key,
      })),
    }));
    const { rows: setMappings } = await db.query(`
      SELECT set_id,source_name,source_record_id,source_version
      FROM fatedrop_card_set_source_mappings
      WHERE source_name IN ('cardmarket','tcgdex')
      ORDER BY set_id,source_name,source_record_id`);
    const report = {
      status: 'audit_complete',
      productionWrites: false,
      source: {
        cardmarketCatalogueSha256: catalogue.artifact.sha256,
        cardmarketPriceGuideSha256: guide.artifact.sha256,
        sourceSnapshotId: guide.snapshot.sourceSnapshotId,
      },
      pricingScope: {
        sourceCardCount: scope.sourceCardCount,
        eligibleCardCount: scope.eligibleCardCount,
        excludedInvalidCatalogueEntryCount: scope.excludedInvalidCatalogueEntryCount,
        excludedUnresolvedEvidenceCount: scope.excludedUnresolvedEvidenceCount,
        pricedCount: priced.size,
        backlogCount: backlog.length,
        sectionA: backlog.filter((row) => row.queueSection === 'A').length,
        sectionB: backlog.filter((row) => row.queueSection === 'B').length,
      },
      backlog,
      existingCardmarketMappings: mappings.map((row) => ({
        cardIdentityId: row.card_identity_id,
        setId: row.set_id,
        setName: row.set_name,
        cardName: row.name,
        collectorNumber: row.collector_number,
        finish: row.variant_code,
        sourceRecordId: String(row.source_record_id),
        sourceVariantKey: row.source_variant_key,
      })),
      setMappings,
    };
    const products = catalogue.products.map((product) => ({
      sourceRecordId: String(product.sourceRecordId),
      name: product.name,
      sourceExpansionId: product.sourceExpansionId,
      sourceMetacardId: product.sourceMetacardId,
      sourceCategoryId: product.sourceCategoryId,
    }));
    const priceGuides = guide.snapshot.priceGuides;
    await Promise.all([
      writeFile(path.join(output, 'production-backlog.json'), JSON.stringify(report)),
      writeFile(path.join(output, 'cardmarket-products.json'), JSON.stringify({ source: report.source, products })),
      writeFile(path.join(output, 'cardmarket-price-guide.json'), JSON.stringify({ source: report.source, priceGuides })),
    ]);
    await db.query('COMMIT');
    console.log(JSON.stringify({ ...report.pricingScope, products: products.length, priceGuideRows: priceGuides.length, productionWrites: false }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
