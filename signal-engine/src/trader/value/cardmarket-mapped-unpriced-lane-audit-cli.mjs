import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const finish = Object.freeze({ standard: { sourceVariantKey: 'normal', priceLane: 'standard' }, holo: { sourceVariantKey: 'holo', priceLane: 'holo' } });

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    const { artifact: guide, snapshot } = await fetchCardmarketPokemonPriceGuide();
    const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
    const { rows } = await db.query(`
      WITH priced AS (
        SELECT DISTINCT card_identity_id
        FROM fatedrop_market_observations
        WHERE source_name='cardmarket'
          AND GREATEST(COALESCE(market_price,0),COALESCE(low_price,0),COALESCE(trend_price,0),COALESCE(avg_1d,0),COALESCE(avg_7d,0),COALESCE(avg_30d,0),COALESCE(avg_lifetime,0),COALESCE(excellent_plus_low,0)) > 0
      )
      SELECT i.id,i.variant_code,p.name,p.collector_number,
             array_agg(DISTINCT m.source_record_id ORDER BY m.source_record_id) FILTER (WHERE m.source_variant_key=CASE WHEN i.variant_code='standard' THEN 'normal' ELSE 'holo' END) AS exact_finish_product_ids,
             count(*) FILTER (WHERE m.source_variant_key=CASE WHEN i.variant_code='standard' THEN 'normal' ELSE 'holo' END)::int AS exact_finish_mapping_rows
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      JOIN fatedrop_card_source_mappings m ON m.card_identity_id=i.id AND m.source_name='cardmarket'
      LEFT JOIN priced pr ON pr.card_identity_id=i.id
      WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN('standard','holo') AND pr.card_identity_id IS NULL
      GROUP BY i.id,i.variant_code,p.name,p.collector_number
      ORDER BY i.id`);

    const counts = { mappedWithoutPositivePrice: rows.length, noExactFinishMapping: 0, exactProductMissingFromGuide: 0, noMeaningfulCurrentLane: 0, ingestableNow: 0, multiExactMapping: 0 };
    const samples = { noExactFinishMapping: [], productMissing: [], noLane: [], ingestableNow: [] };
    for (const row of rows) {
      const ids = Array.isArray(row.exact_finish_product_ids) ? row.exact_finish_product_ids.map(String) : [];
      if (ids.length === 0) { counts.noExactFinishMapping += 1; if (samples.noExactFinishMapping.length < 20) samples.noExactFinishMapping.push(row); continue; }
      if (ids.length > 1) counts.multiExactMapping += 1;
      const policy = finish[row.variant_code];
      const present = ids.map((id) => ({ id, price: priceById.get(id) })).filter((entry) => entry.price);
      if (present.length === 0) { counts.exactProductMissingFromGuide += 1; if (samples.productMissing.length < 20) samples.productMissing.push({ ...row, ids }); continue; }
      const meaningful = present.filter((entry) => hasMeaningfulCardmarketLane(entry.price, policy.priceLane));
      if (meaningful.length === 0) { counts.noMeaningfulCurrentLane += 1; if (samples.noLane.length < 20) samples.noLane.push({ ...row, ids }); continue; }
      counts.ingestableNow += 1;
      if (samples.ingestableNow.length < 20) samples.ingestableNow.push({ ...row, ids: meaningful.map((entry) => entry.id) });
    }
    report = { status: 'audit_complete', productionWrites: false, cardmarketPriceGuideSha256: guide.sha256, counts, samples };
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-mapped-unpriced-lane-audit.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, counts: report.counts, samples: report.samples }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
