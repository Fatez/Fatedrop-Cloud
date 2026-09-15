import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

const INPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-recertification.json');
const OUTPUT = () => path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-full-market-recertification-release.json');
const WRITE = String(process.env.MAPPING_WRITE || '').toLowerCase() === 'true';

function sha256(lines) {
  const hash = createHash('sha256');
  for (const line of lines) hash.update(`${line}\n`);
  return hash.digest('hex');
}

function mappingDigest(rows) {
  return sha256(rows
    .map((row) => [
      row.id,
      row.card_identity_id,
      row.source_record_id,
      row.source_variant_key,
      row.source_url || '',
      row.source_version || '',
    ].join('|'))
    .sort());
}

async function readCurrentMappings(db) {
  const { rows } = await db.query(`
    SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,m.source_url,m.source_version
    FROM fatedrop_card_source_mappings m
    WHERE m.source_name='cardmarket'
    ORDER BY m.id`);
  return rows;
}

export async function release(db, report, { write = WRITE } = {}) {
  if (report?.status !== 'audit_complete' || report?.productionWrites !== false) {
    throw new Error('Completed read-only recertification plan required');
  }
  if (report?.programme !== 'cardmarket_full_market_recertification_v1') {
    throw new Error(`Unexpected recertification programme: ${report?.programme}`);
  }
  if (Number(report?.reconciliation?.unexplained) !== 0) {
    throw new Error(`Refusing release with unexplained identities: ${report?.reconciliation?.unexplained}`);
  }
  if (Number(report?.reconciliation?.expectedVerifiedEnglish) !== Number(report?.reconciliation?.explained)) {
    throw new Error('Verified-English reconciliation does not close');
  }
  const certified = Array.isArray(report.certified) ? report.certified : [];
  if (certified.length !== Number(report?.counts?.certified)) throw new Error('Certified row count drifted inside artifact');

  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-full-market-recertification-v1'))`);

    const before = await readCurrentMappings(db);
    const beforeDigest = mappingDigest(before);
    if (before.length !== Number(report?.precondition?.currentCardmarketMappingRows)
      || beforeDigest !== report?.precondition?.currentCardmarketMappingDigest) {
      throw new Error(`Cardmarket mapping precondition drifted: ${before.length}/${beforeDigest}`);
    }

    await db.query(`
      CREATE TEMP TABLE _fatedrop_cardmarket_recert_plan (
        card_identity_id TEXT PRIMARY KEY,
        source_record_id TEXT NOT NULL,
        source_variant_key TEXT NOT NULL,
        source_url TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('retain','insert','replace')),
        method TEXT NOT NULL,
        cardmarket_product_name TEXT,
        cardmarket_expansion_id TEXT,
        target_lane_priceable BOOLEAN NOT NULL,
        evidence JSONB NOT NULL
      ) ON COMMIT DROP`);

    await db.query(`
      INSERT INTO _fatedrop_cardmarket_recert_plan (
        card_identity_id,source_record_id,source_variant_key,source_url,action,method,
        cardmarket_product_name,cardmarket_expansion_id,target_lane_priceable,evidence
      )
      SELECT
        x.card_identity_id,x.source_record_id,x.source_variant_key,x.source_url,x.action,x.method,
        x.cardmarket_product_name,x.cardmarket_expansion_id,x.target_lane_priceable,x.evidence
      FROM jsonb_to_recordset($1::jsonb) AS x(
        card_identity_id TEXT,
        source_record_id TEXT,
        source_variant_key TEXT,
        source_url TEXT,
        action TEXT,
        method TEXT,
        cardmarket_product_name TEXT,
        cardmarket_expansion_id TEXT,
        target_lane_priceable BOOLEAN,
        evidence JSONB
      )`, [JSON.stringify(certified.map((row) => ({
        card_identity_id: row.cardIdentityId,
        source_record_id: row.sourceRecordId,
        source_variant_key: row.sourceVariantKey,
        source_url: row.reviewedCardmarketUrl,
        action: row.action,
        method: row.method,
        cardmarket_product_name: row.cardmarketProductName,
        cardmarket_expansion_id: row.cardmarketExpansionId,
        target_lane_priceable: Boolean(row.priceEvidence?.targetLane),
        evidence: {
          programme: report.programme,
          certifiedDigest: report.certifiedDigest,
          method: row.method,
          setCode: row.setCode,
          setName: row.setName,
          cardName: row.name,
          collectorNumber: row.collectorNumber,
          variantCode: row.variantCode,
          cardmarketProductName: row.cardmarketProductName,
          cardmarketExpansionId: row.cardmarketExpansionId,
          reviewedCardmarketUrl: row.reviewedCardmarketUrl,
          forensicEvidenceUrl: row.forensicEvidenceUrl || null,
          priceEvidence: row.priceEvidence,
          source: report.source,
        },
      })))]);

    const { rows: [planCount] } = await db.query(`SELECT COUNT(*)::int AS count FROM _fatedrop_cardmarket_recert_plan`);
    if (Number(planCount.count) !== certified.length) throw new Error(`Temporary release plan truncated: ${planCount.count}/${certified.length}`);

    // A certified FateDrop identity owns exactly one Cardmarket source key.
    // Any replace action therefore removes every historical Cardmarket row for
    // that identity, including wrong-lane and duplicate leftovers, before the
    // single deterministic mapping is reinserted.
    const deleted = await db.query(`
      DELETE FROM fatedrop_card_source_mappings m
      USING _fatedrop_cardmarket_recert_plan p
      WHERE p.action='replace'
        AND m.source_name='cardmarket'
        AND m.card_identity_id=p.card_identity_id`);

    const sourceVersion = `full-market-recert-v1:${report.certifiedDigest}`;
    const now = Date.now();

    const retained = await db.query(`
      UPDATE fatedrop_card_source_mappings m
      SET source_url=p.source_url,
          source_version=$1,
          last_observed_at=$2
      FROM _fatedrop_cardmarket_recert_plan p
      WHERE p.action='retain'
        AND m.source_name='cardmarket'
        AND m.card_identity_id=p.card_identity_id
        AND m.source_record_id=p.source_record_id
        AND m.source_variant_key=p.source_variant_key`, [sourceVersion, now]);

    const inserted = await db.query(`
      INSERT INTO fatedrop_card_source_mappings (
        id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version,
        first_observed_at,last_observed_at
      )
      SELECT
        'cm-recert-' || substr(md5(p.card_identity_id || '|' || p.source_record_id || '|' || p.source_variant_key),1,22),
        p.card_identity_id,'cardmarket',p.source_record_id,p.source_variant_key,p.source_url,$1,$2,$2
      FROM _fatedrop_cardmarket_recert_plan p
      WHERE p.action IN ('insert','replace')`, [sourceVersion, now]);

    const provenance = await db.query(`
      INSERT INTO fatedrop_card_provenance (
        id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,
        observed_at,evidence_status,evidence_json,created_at
      )
      SELECT
        'prov-cm-recert-' || substr(md5(p.card_identity_id || '|' || p.source_record_id || '|' || p.source_variant_key || '|' || $1),1,18),
        p.card_identity_id,'cardmarket',p.source_record_id,p.source_variant_key,p.source_url,
        $2,'accepted',p.evidence,$2
      FROM _fatedrop_cardmarket_recert_plan p
      ON CONFLICT (id) DO NOTHING`, [report.certifiedDigest, now]);

    const { rows: [verification] } = await db.query(`
      SELECT
        COUNT(*)::int AS planned,
        COUNT(*) FILTER (WHERE exact_rows=1)::int AS exact,
        COUNT(*) FILTER (WHERE exact_rows<>1)::int AS bad_exact,
        COUNT(*) FILTER (WHERE identity_rows<>1)::int AS identities_with_extra_rows,
        COUNT(*) FILTER (WHERE foreign_owners>0)::int AS foreign_owner_rows,
        COUNT(*) FILTER (WHERE url_matches=false)::int AS bad_url
      FROM (
        SELECT p.card_identity_id,
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
        FROM _fatedrop_cardmarket_recert_plan p
      ) q`);

    if (Number(verification.planned) !== certified.length
      || Number(verification.bad_exact) !== 0
      || Number(verification.identities_with_extra_rows) !== 0
      || Number(verification.foreign_owner_rows) !== 0
      || Number(verification.bad_url) !== 0) {
      throw new Error(`Release verification failed: ${JSON.stringify(verification)}`);
    }

    if (write) await db.query('COMMIT');
    else await db.query('ROLLBACK');

    return {
      status: write ? 'production_written' : 'rehearsal_passed',
      productionWrites: write,
      certifiedDigest: report.certifiedDigest,
      counts: {
        certified: certified.length,
        plannedRetains: certified.filter((row) => row.action === 'retain').length,
        plannedInserts: certified.filter((row) => row.action === 'insert').length,
        plannedReplacements: certified.filter((row) => row.action === 'replace').length,
        deletedRows: deleted.rowCount,
        retainedRowsUpdated: retained.rowCount,
        insertedRows: inserted.rowCount,
        provenanceRowsInserted: provenance.rowCount,
      },
      verification,
      reconciliation: report.reconciliation,
    };
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const report = JSON.parse(await readFile(INPUT(), 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let result;
  try {
    result = await release(db, report);
  } catch (error) {
    result = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(OUTPUT(), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();