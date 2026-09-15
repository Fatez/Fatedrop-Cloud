import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

const INPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-recertification.json');
const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-recertification-verify.json');

export async function verify(db, report) {
  if (report?.status !== 'audit_complete' || report?.programme !== 'cardmarket_full_market_recertification_v1') {
    throw new Error('Completed full-market recertification plan required');
  }
  if (Number(report?.reconciliation?.unexplained) !== 0) throw new Error('Plan contains unexplained identities');
  const certified = Array.isArray(report.certified) ? report.certified : [];

  const payload = certified.map((row) => ({
    card_identity_id: row.cardIdentityId,
    source_record_id: row.sourceRecordId,
    source_variant_key: row.sourceVariantKey,
    source_url: row.reviewedCardmarketUrl,
    target_lane_priceable: Boolean(row.priceEvidence?.targetLane),
  }));

  const { rows: [mapping] } = await db.query(`
    WITH plan AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        card_identity_id TEXT,
        source_record_id TEXT,
        source_variant_key TEXT,
        source_url TEXT,
        target_lane_priceable BOOLEAN
      )
    ), checks AS (
      SELECT p.*,
        (SELECT COUNT(*) FROM fatedrop_card_source_mappings m
          WHERE m.source_name='cardmarket'
            AND m.card_identity_id=p.card_identity_id) AS identity_rows,
        (SELECT COUNT(*) FROM fatedrop_card_source_mappings m
          WHERE m.source_name='cardmarket'
            AND m.card_identity_id=p.card_identity_id
            AND m.source_record_id=p.source_record_id
            AND m.source_variant_key=p.source_variant_key) AS exact_rows,
        (SELECT COUNT(*) FROM fatedrop_card_source_mappings m
          WHERE m.source_name='cardmarket'
            AND m.source_record_id=p.source_record_id
            AND m.source_variant_key=p.source_variant_key
            AND m.card_identity_id<>p.card_identity_id) AS foreign_owners,
        EXISTS (
          SELECT 1 FROM fatedrop_card_source_mappings m
          WHERE m.source_name='cardmarket'
            AND m.card_identity_id=p.card_identity_id
            AND m.source_record_id=p.source_record_id
            AND m.source_variant_key=p.source_variant_key
            AND m.source_url=p.source_url
        ) AS url_matches
      FROM plan p
    )
    SELECT
      COUNT(*)::int AS planned,
      COUNT(*) FILTER (WHERE exact_rows=1)::int AS exact,
      COUNT(*) FILTER (WHERE exact_rows<>1)::int AS bad_exact,
      COUNT(*) FILTER (WHERE identity_rows<>1)::int AS identities_with_extra_rows,
      COUNT(*) FILTER (WHERE foreign_owners>0)::int AS foreign_owner_rows,
      COUNT(*) FILTER (WHERE url_matches=false)::int AS bad_url
    FROM checks`, [JSON.stringify(payload)]);

  const { rows: [pricing] } = await db.query(`
    WITH plan AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        card_identity_id TEXT,
        source_record_id TEXT,
        source_variant_key TEXT,
        source_url TEXT,
        target_lane_priceable BOOLEAN
      )
    ), priced AS (
      SELECT p.card_identity_id,
        EXISTS (
          SELECT 1 FROM fatedrop_market_observations o
          WHERE o.card_identity_id=p.card_identity_id
            AND o.source_name='cardmarket'
            AND GREATEST(
              COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),
              COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0)
            ) > 0
        ) AS positive
      FROM plan p
      WHERE p.target_lane_priceable=true
    )
    SELECT COUNT(*)::int AS expected_priceable,
      COUNT(*) FILTER (WHERE positive)::int AS positively_priced,
      COUNT(*) FILTER (WHERE NOT positive)::int AS missing_positive_price
    FROM priced`, [JSON.stringify(payload)]);

  const { rows: [catalogue] } = await db.query(`
    SELECT COUNT(*)::int AS verified_english
    FROM fatedrop_card_identities
    WHERE verification_status='verified' AND language_code='en'`);

  const expected = Number(report.reconciliation.expectedVerifiedEnglish);
  if (Number(catalogue.verified_english) !== expected) {
    throw new Error(`Verified English catalogue drifted after plan: ${catalogue.verified_english}/${expected}`);
  }
  if (Number(mapping.planned) !== certified.length
    || Number(mapping.bad_exact) !== 0
    || Number(mapping.identities_with_extra_rows) !== 0
    || Number(mapping.foreign_owner_rows) !== 0
    || Number(mapping.bad_url) !== 0) {
    throw new Error(`Exact Cardmarket mapping verification failed: ${JSON.stringify(mapping)}`);
  }
  if (Number(pricing.missing_positive_price) !== 0) {
    throw new Error(`Cardmarket price ingestion missed ${pricing.missing_positive_price}/${pricing.expected_priceable} deterministically priceable identities`);
  }

  return {
    status: 'production_verified',
    certifiedDigest: report.certifiedDigest,
    catalogue: {
      verifiedEnglish: Number(catalogue.verified_english),
      certified: certified.length,
      quarantined: Number(report.reconciliation.quarantined),
      unexplained: Number(report.reconciliation.unexplained),
    },
    mappings: Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, Number(value)])),
    pricing: Object.fromEntries(Object.entries(pricing).map(([key, value]) => [key, Number(value)])),
  };
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const report = JSON.parse(await readFile(INPUT(), 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let result;
  try {
    result = await verify(db, report);
  } catch (error) {
    result = { status: 'blocked', error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(OUTPUT(), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();