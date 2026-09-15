import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { build as buildExactProof } from './cardmarket-full-market-exact-proof-cli.mjs';
import { runCardmarketPokemonMarketCycle } from './cardmarket-market-cycle.mjs';

const mode = process.env.FINAL_PRICING_MODE || 'rehearse';
if (!['rehearse', 'activate'].includes(mode)) throw new Error('Unknown FINAL_PRICING_MODE');
validateProductionTarget(process.env.DATABASE_URL);
if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');

const EDITIONED_SET_CODES = ['base1','base2','base3','base4','base5','gym1','gym2','neo1','neo2','neo3','neo4'];
const mapId = (row) => `fdcardmap_${createHash('sha256').update(`cardmarket|${row.cardIdentityId}|${row.sourceRecordId}|${row.sourceVariantKey}`).digest('hex').slice(0, 24)}`;

async function latestCardmarketDay(db) {
  const { rows } = await db.query(`SELECT MAX(market_day)::date AS market_day FROM fatedrop_market_observations WHERE source_name='cardmarket'`);
  return rows[0]?.market_day || null;
}

async function countCoverage(db, marketDay) {
  const { rows } = await db.query(`
    WITH target AS (
      SELECT i.id
      FROM fatedrop_card_identities i
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
      WHERE i.verification_status='verified' AND i.language_code='en'
        AND i.variant_code IN ('standard','holo')
        AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
    )
    SELECT COUNT(*)::int AS eligible,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM fatedrop_market_observations o
        WHERE o.card_identity_id=t.id AND o.source_name='cardmarket' AND o.market_day=$1::date
      ))::int AS observed,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM fatedrop_market_observations o
        WHERE o.card_identity_id=t.id AND o.source_name='cardmarket' AND o.market_day=$1::date
      ))::int AS unobserved
    FROM target t`, [marketDay]);
  return rows[0];
}

async function unmappedEligibleIds(db) {
  const { rows } = await db.query(`
    SELECT i.id AS card_identity_id,i.variant_code
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified' AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.card_identity_id=i.id AND m.source_name='cardmarket'
      )
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_set_source_mappings sm
        WHERE sm.set_id=p.set_id AND sm.source_name='tcgdex' AND sm.source_record_id=ANY($1::text[])
      )
    ORDER BY i.id`, [EDITIONED_SET_CODES]);
  return rows;
}

async function currentMappingState(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket' AND card_identity_id=ANY($1::text[])`, [ids]);
  return new Map(rows.map((row) => [row.card_identity_id, row]));
}

async function sourceOwners(db, rows) {
  const out = new Map();
  for (const row of rows) {
    const { rows: owners } = await db.query(`
      SELECT card_identity_id FROM fatedrop_card_source_mappings
      WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,
      [String(row.sourceRecordId), row.sourceVariantKey]);
    out.set(`${row.sourceRecordId}|${row.sourceVariantKey}`, owners.map((owner) => owner.card_identity_id));
  }
  return out;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let db;
let report = { status: 'blocked', mode, productionWrites: false };
try {
  db = await pool.connect();
  const exact = await buildExactProof(db);
  if (exact.status !== 'audit_complete') throw new Error(`Exact proof did not complete: ${exact.status}`);

  const marketDay = await latestCardmarketDay(db);
  if (!marketDay) throw new Error('No Cardmarket market day is available');
  const coverageBefore = await countCoverage(db, marketDay);
  const unmapped = await unmappedEligibleIds(db);
  const unmappedSet = new Set(unmapped.map((row) => row.card_identity_id));
  const safeById = new Map(exact.safeMappings.map((row) => [row.cardIdentityId, row]));

  const exactCandidates = unmapped
    .map((target) => safeById.get(target.card_identity_id))
    .filter(Boolean)
    .filter((row) => ['standard','holo'].includes(row.variantCode))
    .filter((row) => row.priceEvidence?.targetLane === true);

  const noExactOrPricedLane = unmapped.filter((target) => !exactCandidates.some((row) => row.cardIdentityId === target.card_identity_id));
  const byVariant = exactCandidates.reduce((acc, row) => {
    acc[row.variantCode] = (acc[row.variantCode] || 0) + 1;
    return acc;
  }, {});

  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-final-pricing-url-recovery'))");

  const ids = exactCandidates.map((row) => row.cardIdentityId);
  const existing = await currentMappingState(db, ids);
  if (existing.size) throw new Error(`Candidate mapping state changed before write (${existing.size} identities now mapped)`);
  const owners = await sourceOwners(db, exactCandidates);
  for (const row of exactCandidates) {
    const foreign = (owners.get(`${row.sourceRecordId}|${row.sourceVariantKey}`) || []).filter((id) => id !== row.cardIdentityId);
    if (foreign.length) throw new Error(`Source key became owned before write: ${row.sourceRecordId}/${row.sourceVariantKey}`);
  }

  const beforeCounts = (await db.query(`SELECT
    (SELECT COUNT(*)::int FROM fatedrop_card_source_mappings) AS mappings,
    (SELECT COUNT(*)::int FROM fatedrop_market_observations) AS observations`)).rows[0];

  const now = Date.now();
  let insertedMappings = 0;
  for (const row of exactCandidates) {
    const result = await db.query(`
      INSERT INTO fatedrop_card_source_mappings
        (id,card_identity_id,source_name,source_record_id,source_variant_key,source_url,source_version,first_observed_at,last_observed_at)
      VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$7,$7)
      RETURNING id`, [
        mapId(row), row.cardIdentityId, String(row.sourceRecordId), row.sourceVariantKey,
        row.reviewedCardmarketUrl || null, exact.source.cardmarketCatalogueSha256, now,
      ]);
    insertedMappings += result.rowCount;
  }
  if (insertedMappings !== exactCandidates.length) throw new Error('Not every approved insert-only mapping was inserted');

  const nestedClient = {
    query: (query, params) => ['BEGIN','COMMIT','ROLLBACK'].includes(query)
      ? Promise.resolve({ rows: [], rowCount: 0 }) : db.query(query, params),
    release() {},
  };
  const transactionStore = { pool: async () => ({
    query: (query, params) => db.query(query, params), connect: async () => nestedClient,
  }) };
  const cycle = await runCardmarketPokemonMarketCycle({ store: transactionStore, mode: 'persist', includeReadiness: false });
  if (cycle.artifact.sha256 !== exact.source.cardmarketPriceGuideSha256) {
    throw new Error('Cardmarket price guide changed between exact proof and price-cycle rehearsal');
  }

  const afterCounts = (await db.query(`SELECT
    (SELECT COUNT(*)::int FROM fatedrop_card_source_mappings) AS mappings,
    (SELECT COUNT(*)::int FROM fatedrop_market_observations) AS observations`)).rows[0];
  if (afterCounts.mappings !== beforeCounts.mappings + insertedMappings) throw new Error('Unexpected mapping count change');
  if (afterCounts.observations !== beforeCounts.observations + cycle.persistence.insertedObservations) throw new Error('Unexpected observation count change');

  const coverageAfter = await countCoverage(db, marketDay);
  const finalUnmappedInTxn = (await unmappedEligibleIds(db)).length;
  await db.query(mode === 'activate' ? 'COMMIT' : 'ROLLBACK');

  report = {
    status: 'complete', mode, productionWrites: mode === 'activate', marketDay,
    exactProof: { counts: exact.counts, source: exact.source },
    gap: {
      eligibleUnmappedBefore: unmapped.length,
      exactPricedInsertCandidates: exactCandidates.length,
      exactPricedInsertCandidatesByVariant: byVariant,
      unresolvedOrNoPublicTargetLane: noExactOrPricedLane.length,
      unresolvedSample: noExactOrPricedLane.slice(0, 30),
      eligibleUnmappedAfterInTransaction: finalUnmappedInTxn,
    },
    coverageBefore, coverageAfter,
    persistence: { insertedMappings, insertedObservations: cycle.persistence.insertedObservations },
    cycle: {
      sourceSnapshotId: cycle.sourceSnapshotId,
      artifactSha256: cycle.artifact.sha256,
      recordsSeen: cycle.recordsSeen,
      recordsAccepted: cycle.recordsAccepted,
      recordsRejected: cycle.recordsRejected,
      persistence: cycle.persistence,
    },
  };
} catch (error) {
  if (db) {
    try { await db.query('ROLLBACK'); } catch {}
  }
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  db?.release();
  await pool.end();
  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-final-pricing-url-recovery.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
