import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { buildResolutionLedger } from './variant-resolution-ledger.mjs';
import { buildVariantResolutionActivationPlan, renderDeltaActivationSql } from './variant-resolution-activation.mjs';
import { loadPersistedApprovedFinishEvidence, mergeReviewedFinishDecisions } from './persisted-finish-evidence.mjs';

const hash = raw => createHash('sha256').update(raw).digest('hex');
const reviewId = decision => `fdreview_${hash([decision.cardIdentityId, decision.finish, decision.snapshotSha256, decision.verdict, decision.reviewReference].join('|')).slice(0, 32)}`;
const flagId = row => `fdflag_${hash(`${row.cardIdentityId}|invalid_catalogue_entry|${row.evidenceSha256}`).slice(0, 32)}`;

function positivePrice(row) {
  for (const field of ['market_price', 'trend_price', 'avg_1d', 'avg_7d', 'avg_30d', 'avg_lifetime', 'low_price']) {
    const value = Number(row[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export async function loadCurrentExactPrices(db, identityIds, snapshotMap) {
  if (!identityIds.length) return [];
  const { rows } = await db.query(`
    SELECT o.card_identity_id,o.currency_code,o.observed_at,o.market_price,o.trend_price,o.avg_1d,o.avg_7d,o.avg_30d,o.avg_lifetime,o.low_price,
           o.id AS observation_id,m.id AS mapping_id,m.source_record_id,m.source_variant_key,
           i.variant_code,i.language_code,i.verification_status
    FROM fatedrop_market_observations o
    JOIN fatedrop_card_source_mappings m ON m.id=o.card_source_mapping_id
    JOIN fatedrop_card_identities i ON i.id=o.card_identity_id
    WHERE o.card_identity_id=ANY($1::text[])
      AND o.source_name='cardmarket'
      AND m.source_name='cardmarket'
      AND i.verification_status='verified'
    ORDER BY o.card_identity_id,o.observed_at DESC`, [identityIds]);
  const latest = new Map();
  for (const row of rows) {
    if (latest.has(row.card_identity_id)) continue;
    const amount = positivePrice(row);
    if (amount == null) continue;
    const raw = JSON.stringify({
      observationId: row.observation_id, mappingId: row.mapping_id, cardIdentityId: row.card_identity_id,
      productId: String(row.source_record_id), subtype: row.source_variant_key, currency: row.currency_code,
      amount, observedAt: Number(row.observed_at),
    });
    const snapshotSha256 = hash(raw);
    snapshotMap[snapshotSha256] = raw;
    latest.set(row.card_identity_id, {
      cardIdentityId: row.card_identity_id,
      finish: row.variant_code,
      language: row.language_code,
      edition: 'unspecified',
      exactMappingVerified: true,
      mappingReviewReference: `production-exact-mapping:${row.mapping_id}`,
      provider: 'cardmarket',
      productId: String(row.source_record_id),
      subtype: row.source_variant_key,
      currency: row.currency_code,
      amount,
      observedAt: Number(row.observed_at),
      snapshotSha256,
    });
  }
  return [...latest.values()];
}

function assertExpectedCounts(plan) {
  const names = {
    ACTIVE_PRICED: 'EXPECTED_ACTIVE_PRICED',
    ACTIVE_UNPRICED: 'EXPECTED_ACTIVE_UNPRICED',
    INVALID_CATALOGUE_ENTRY: 'EXPECTED_INVALID_CATALOGUE_ENTRY',
    UNRESOLVED_EVIDENCE: 'EXPECTED_UNRESOLVED_EVIDENCE',
  };
  for (const [state, envName] of Object.entries(names)) {
    if (process.env[envName] === undefined || process.env[envName] === '') continue;
    const expected = Number(process.env[envName]);
    if (!Number.isSafeInteger(expected) || expected < 0 || plan.counts[state] !== expected) {
      throw new Error(`${envName} expected ${process.env[envName]}, found ${plan.counts[state]}`);
    }
  }
}

async function assertPinnedSnapshotsPersisted(db, plan) {
  const resolved = plan.rows.filter(row => row.state !== 'UNRESOLVED_EVIDENCE');
  const evidenceShas = [...new Set(resolved.map(row => row.evidenceSha256).filter(Boolean))];
  if (!evidenceShas.length) return new Map();
  const { rows } = await db.query(`SELECT id,card_identity_id,payload_sha256 FROM fatedrop_variant_evidence_snapshots WHERE payload_sha256=ANY($1::text[])`, [evidenceShas]);
  const exact = new Map(rows.map(row => [`${row.card_identity_id}|${row.payload_sha256}`, row.id]));
  for (const row of resolved) {
    if (!row.evidenceSha256 || !exact.has(`${row.cardIdentityId}|${row.evidenceSha256}`)) {
      throw new Error(`Pinned evidence snapshot is not persisted for ${row.cardIdentityId}`);
    }
  }
  return exact;
}

export async function persistVariantResolutionActivation(db, plan, currentDecisions) {
  if (plan.productionWrites !== false || plan.priceWrites !== false || plan.baseCardDeletes !== false) throw new Error('Unsafe activation plan');
  const snapshotByKey = await assertPinnedSnapshotsPersisted(db, plan);
  const ids = plan.rows.map(row => row.cardIdentityId);
  const { rows: current } = await db.query(`SELECT id,variant_code,language_code,verification_status FROM fatedrop_card_identities WHERE id=ANY($1::text[])`, [ids]);
  const byId = new Map(current.map(row => [row.id, row]));
  for (const row of plan.rows) {
    const identity = byId.get(row.cardIdentityId);
    if (!identity || identity.verification_status !== 'verified' || identity.variant_code !== row.finish || identity.language_code !== row.language) {
      throw new Error(`Canonical identity drift for ${row.cardIdentityId}`);
    }
  }
  const { rows: activeFlags } = await db.query(`SELECT card_identity_id FROM fatedrop_catalogue_audit_flags WHERE active=TRUE AND card_identity_id=ANY($1::text[])`, [ids]);
  const invalidFlagged = new Set(activeFlags.map(row => row.card_identity_id));
  for (const row of plan.rows) {
    if ((row.state === 'ACTIVE_PRICED' || row.state === 'ACTIVE_UNPRICED') && invalidFlagged.has(row.cardIdentityId)) {
      throw new Error(`Active state conflicts with existing invalid catalogue flag for ${row.cardIdentityId}`);
    }
  }

  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-variant-resolution-activation'))`);
    const now = Date.now();
    for (const decision of currentDecisions) {
      const snapshotId = snapshotByKey.get(`${decision.cardIdentityId}|${decision.snapshotSha256}`)
        ?? (await db.query(`SELECT id FROM fatedrop_variant_evidence_snapshots WHERE card_identity_id=$1 AND payload_sha256=$2`, [decision.cardIdentityId, decision.snapshotSha256])).rows[0]?.id;
      if (!snapshotId) throw new Error(`Current reviewed decision snapshot is not persisted for ${decision.cardIdentityId}`);
      await db.query(`INSERT INTO fatedrop_variant_evidence_reviews
        (id,snapshot_id,card_identity_id,finish,language,edition,observed_finish,verdict,basis,review_reference,reviewer,approval_state,reviewed_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved',$12,$12)
        ON CONFLICT (snapshot_id,card_identity_id,finish,verdict,review_reference) DO NOTHING`, [
        reviewId(decision), snapshotId, decision.cardIdentityId, decision.finish, decision.language, decision.edition,
        decision.observedFinish || decision.finish, decision.verdict, decision.basis, decision.reviewReference,
        decision.reviewer || 'fatedrop-review', now,
      ]);
    }

    for (const row of plan.rows) {
      await db.query(`INSERT INTO fatedrop_variant_resolution_state
        (card_identity_id,finish,language,edition,classifier_state,reason,evidence_sha256,review_reference,classified_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        ON CONFLICT (card_identity_id) DO UPDATE SET finish=EXCLUDED.finish,language=EXCLUDED.language,edition=EXCLUDED.edition,
          classifier_state=EXCLUDED.classifier_state,reason=EXCLUDED.reason,evidence_sha256=EXCLUDED.evidence_sha256,
          review_reference=EXCLUDED.review_reference,classified_at=EXCLUDED.classified_at,updated_at=EXCLUDED.updated_at`, [
        row.cardIdentityId,row.finish,row.language,row.edition,row.state,row.reason,row.evidenceSha256,row.reviewReference,row.classifiedAt,
      ]);
      if (row.state === 'UNRESOLVED_EVIDENCE') {
        await db.query(`INSERT INTO fatedrop_variant_audit_hold (card_identity_id,finish,reason,evidence_sha256,active,created_at,updated_at,resolved_at)
          VALUES ($1,$2,$3,$4,TRUE,$5,$5,NULL)
          ON CONFLICT (card_identity_id) DO UPDATE SET finish=EXCLUDED.finish,reason=EXCLUDED.reason,evidence_sha256=EXCLUDED.evidence_sha256,active=TRUE,updated_at=EXCLUDED.updated_at,resolved_at=NULL`,
          [row.cardIdentityId,row.finish,row.reason,row.evidenceSha256,now]);
      } else {
        await db.query(`UPDATE fatedrop_variant_audit_hold SET active=FALSE,updated_at=$2,resolved_at=$2 WHERE card_identity_id=$1 AND active=TRUE`, [row.cardIdentityId,now]);
      }
      if (row.state === 'INVALID_CATALOGUE_ENTRY') {
        await db.query(`INSERT INTO fatedrop_catalogue_audit_flags (id,card_identity_id,flag_type,reason,evidence_sha256,review_reference,active,created_at,resolved_at)
          VALUES ($1,$2,'invalid_catalogue_entry',$3,$4,$5,TRUE,$6,NULL) ON CONFLICT (id) DO NOTHING`,
          [flagId(row),row.cardIdentityId,row.reason,row.evidenceSha256,row.reviewReference,now]);
      }
    }
    await db.query('COMMIT');
    return { savedStates: plan.rows.length, savedReviews: currentDecisions.length, priceWrites: 0, baseCardDeletes: 0 };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (process.env.PRICE_WRITE === 'true') throw new Error('Variant resolution activation never writes prices');
  const auditPath = process.argv[2];
  const reviewedPath = process.argv[3];
  const outputDir = process.argv[4] || process.env.RUNNER_TEMP || '.';
  if (!auditPath || !reviewedPath) throw new Error('Usage: node variant-resolution-activation-cli.mjs frozen-audit.json reviewed-evidence.json [output-dir]');
  validateProductionTarget(process.env.DATABASE_URL);
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  const reviewed = JSON.parse(await readFile(reviewedPath, 'utf8'));
  if (reviewed?.productionWrites !== false || reviewed?.priceWrites !== false || !Array.isArray(reviewed?.decisions) || typeof reviewed?.snapshots !== 'object') {
    throw new Error('Expected read-only reviewed evidence');
  }
  const rows = audit.held.filter(row => row.reason === 'external_target_finish_absent').map(row => ({ ...row, language: 'en', edition: 'unspecified' }));
  if (rows.length !== 1121) throw new Error(`Expected frozen 1121 cohort, found ${rows.length}`);
  const snapshots = { ...reviewed.snapshots };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    const identityIds = rows.map(row => row.cardIdentityId);
    const persistedDecisions = await loadPersistedApprovedFinishEvidence(db, identityIds, snapshots);
    const decisions = mergeReviewedFinishDecisions(persistedDecisions, reviewed.decisions);
    const prices = await loadCurrentExactPrices(db, identityIds, snapshots);
    const now = Date.now();
    const ledger = buildResolutionLedger(rows, { decisions, snapshots, prices, now });
    const plan = buildVariantResolutionActivationPlan(ledger, { classifiedAt: now });
    assertExpectedCounts(plan);
    const sql = renderDeltaActivationSql(plan);
    await writeFile(`${outputDir}/variant-resolution-ledger.json`, JSON.stringify(ledger, null, 2));
    await writeFile(`${outputDir}/variant-resolution-activation-plan.json`, JSON.stringify(plan, null, 2));
    await writeFile(`${outputDir}/delta_activation.sql`, sql);
    report = {
      status: 'clean', productionWrites: false, priceWrites: false,
      counts: plan.counts, deltaSha256: plan.deltaSha256,
      evidence: { persistedApproved: persistedDecisions.length, currentReviewed: reviewed.decisions.length, cumulativeReviewed: decisions.length },
    };
    if (process.env.ACTIVATION_WRITE === 'true') {
      const persistence = await persistVariantResolutionActivation(db, plan, reviewed.decisions);
      report = { ...report, productionWrites: true, persistence };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, priceWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${outputDir}/variant-resolution-activation-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
