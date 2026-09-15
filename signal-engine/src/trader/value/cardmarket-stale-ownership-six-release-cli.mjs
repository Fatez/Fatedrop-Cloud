import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { marketObservationFromPostgres, normaliseMarketObservationCandidate } from './market-observation.mjs';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import {
  CARDMARKET_STALE_OWNERSHIP_SIX,
  CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST,
  stableCardmarketMappingId,
} from './cardmarket-stale-ownership-six.mjs';

const AUDIT_PATH = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-stale-ownership-six-audit.json');
const OUTPUT_PATH = path.join(process.env.RUNNER_TEMP || '.', 'cardmarket-stale-ownership-six-release.json');

function assertFrozenAudit(report) {
  if (report?.status !== 'audit_complete' || report?.productionWrites !== false) throw new Error('Completed read-only stale-ownership audit required');
  if (report.manifestDigest !== CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST) throw new Error('Stale-ownership manifest digest drift');
  if (report.count !== CARDMARKET_STALE_OWNERSHIP_SIX.length || report.pairs?.length !== CARDMARKET_STALE_OWNERSHIP_SIX.length) throw new Error('Stale-ownership audit count drift');
  if (!report.cardmarketCatalogueSha256) throw new Error('Cardmarket catalogue hash missing from stale-ownership audit');
  for (const pair of CARDMARKET_STALE_OWNERSHIP_SIX) {
    const audited = report.pairs.find((row) => row.key === pair.key);
    if (!audited) throw new Error(`Frozen audit missing ${pair.key}`);
    if (String(audited.target?.sourceRecordId) !== String(pair.target.sourceRecordId)
      || String(audited.displaced?.sourceRecordId) !== String(pair.displaced.sourceRecordId)
      || audited.sourceVariantKey !== pair.sourceVariantKey
      || audited.staleMappingId !== pair.staleMappingId) {
      throw new Error(`Frozen audit mismatch for ${pair.key}`);
    }
  }
}

async function validateIdentity(db, expected) {
  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,i.collector_number,
      p.name,p.attributes->'artwork'->>'sourceRecordId' AS tcgdex_id,s.name AS set_name,
      rs.classifier_state
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.id=$1 FOR UPDATE OF i`, [expected.cardIdentityId]);
  const row = rows[0];
  if (!row
    || row.verification_status !== 'verified'
    || row.language_code !== 'en'
    || row.variant_code !== expected.variantCode
    || String(row.collector_number) !== String(expected.collectorNumber)
    || row.name !== expected.name
    || row.set_name !== expected.setName
    || row.tcgdex_id !== expected.tcgdexId
    || ['INVALID_CATALOGUE_ENTRY', 'UNRESOLVED_EVIDENCE'].includes(row.classifier_state)) {
    throw new Error(`Canonical identity/state drift: ${expected.cardIdentityId}`);
  }
}

async function pairState(db, pair) {
  const { rows: mappings } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
      AND (card_identity_id IN ($1,$2)
        OR (source_record_id IN ($3,$4) AND source_variant_key=$5)
        OR id=$6)
    ORDER BY id FOR UPDATE`, [
    pair.target.cardIdentityId, pair.displaced.cardIdentityId,
    pair.target.sourceRecordId, pair.displaced.sourceRecordId,
    pair.sourceVariantKey, pair.staleMappingId,
  ]);
  const targetMappingId = stableCardmarketMappingId(pair.target.cardIdentityId, pair.target.sourceRecordId, pair.sourceVariantKey);
  const displacedMappingId = stableCardmarketMappingId(pair.displaced.cardIdentityId, pair.displaced.sourceRecordId, pair.sourceVariantKey);
  const targetSource = mappings.find((row) => String(row.source_record_id) === String(pair.target.sourceRecordId) && row.source_variant_key === pair.sourceVariantKey);
  const displacedSource = mappings.find((row) => String(row.source_record_id) === String(pair.displaced.sourceRecordId) && row.source_variant_key === pair.sourceVariantKey);
  const targetMappings = mappings.filter((row) => row.card_identity_id === pair.target.cardIdentityId);
  const displacedMappings = mappings.filter((row) => row.card_identity_id === pair.displaced.cardIdentityId);

  const stale = Boolean(
    targetSource
    && targetSource.id === pair.staleMappingId
    && targetSource.card_identity_id === pair.displaced.cardIdentityId
    && !displacedSource
    && targetMappings.length === 0
    && displacedMappings.length === 1
  );
  const corrected = Boolean(
    targetSource
    && targetSource.id === targetMappingId
    && targetSource.card_identity_id === pair.target.cardIdentityId
    && displacedSource
    && displacedSource.id === displacedMappingId
    && displacedSource.card_identity_id === pair.displaced.cardIdentityId
    && targetMappings.length === 1
    && displacedMappings.length === 1
  );
  return { stale, corrected, targetMappingId, displacedMappingId, targetSource, displacedSource, mappings };
}

async function correctPair(db, pair, catalogueSha) {
  await validateIdentity(db, pair.target);
  await validateIdentity(db, pair.displaced);
  const state = await pairState(db, pair);
  if (state.corrected) return { key: pair.key, status: 'already_corrected', movedObservations: 0 };
  if (!state.stale) throw new Error(`Ownership state is neither frozen-stale nor fully-corrected for ${pair.key}`);

  const { rows: [obsCheck] } = await db.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE card_identity_id<>$2 OR source_record_id<>$3 OR source_variant_key<>$4)::int AS mismatched
    FROM fatedrop_market_observations WHERE card_source_mapping_id=$1`, [
    pair.staleMappingId, pair.displaced.cardIdentityId, pair.target.sourceRecordId, pair.sourceVariantKey,
  ]);
  if (Number(obsCheck?.mismatched || 0) !== 0) throw new Error(`Historical observation ownership drift for ${pair.key}`);

  const tempSourceRecordId = `retired-stale:${pair.staleMappingId}`;
  const now = Date.now();
  const moved = await db.query(`
    UPDATE fatedrop_card_source_mappings
    SET source_record_id=$2,source_version=$3,last_observed_at=$4
    WHERE id=$1 AND source_name='cardmarket' AND card_identity_id=$5 AND source_record_id=$6 AND source_variant_key=$7`, [
    pair.staleMappingId, tempSourceRecordId, catalogueSha, now,
    pair.displaced.cardIdentityId, pair.target.sourceRecordId, pair.sourceVariantKey,
  ]);
  if (moved.rowCount !== 1) throw new Error(`Failed to quarantine stale mapping for ${pair.key}`);

  await db.query(`
    INSERT INTO fatedrop_card_source_mappings(
      id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
    ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)`, [
    state.targetMappingId, pair.target.cardIdentityId, pair.target.sourceRecordId,
    pair.sourceVariantKey, catalogueSha, now,
  ]);

  const { rows: historicalObservations } = await db.query(
    'SELECT * FROM fatedrop_market_observations WHERE card_source_mapping_id=$1 FOR UPDATE', [pair.staleMappingId]);
  for (const row of historicalObservations) {
    const original = marketObservationFromPostgres(row);
    if (original.id !== row.id || original.contentFingerprint !== row.content_fingerprint) {
      throw new Error(`Historical observation fingerprint drift: ${row.id}`);
    }
    const corrected = normaliseMarketObservationCandidate({ ...original,
      cardIdentityId: pair.target.cardIdentityId, cardSourceMappingId: state.targetMappingId });
    const movedObservation = await db.query(`UPDATE fatedrop_market_observations
      SET card_identity_id=$2,card_source_mapping_id=$3,content_fingerprint=$4
      WHERE id=$1 AND content_fingerprint=$5`, [row.id, corrected.cardIdentityId,
      corrected.cardSourceMappingId, corrected.contentFingerprint, row.content_fingerprint]);
    if (movedObservation.rowCount !== 1) throw new Error(`Observation move drift: ${row.id}`);
  }
  const observations = { rowCount: historicalObservations.length };
  if (observations.rowCount !== Number(obsCheck?.total || 0)) throw new Error(`Observation move count drift for ${pair.key}`);

  const removed = await db.query(`DELETE FROM fatedrop_card_source_mappings WHERE id=$1`, [pair.staleMappingId]);
  if (removed.rowCount !== 1) throw new Error(`Failed to retire stale mapping for ${pair.key}`);

  await db.query(`
    INSERT INTO fatedrop_card_source_mappings(
      id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
    ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)`, [
    state.displacedMappingId, pair.displaced.cardIdentityId, pair.displaced.sourceRecordId,
    pair.sourceVariantKey, catalogueSha, now,
  ]);

  const verified = await pairState(db, pair);
  if (!verified.corrected) throw new Error(`Post-correction verification failed for ${pair.key}`);
  const { rows: [obsAfter] } = await db.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE card_identity_id<>$2 OR source_record_id<>$3 OR source_variant_key<>$4)::int AS mismatched
    FROM fatedrop_market_observations WHERE card_source_mapping_id=$1`, [
    state.targetMappingId, pair.target.cardIdentityId, pair.target.sourceRecordId, pair.sourceVariantKey,
  ]);
  if (Number(obsAfter?.total || 0) !== Number(obsCheck?.total || 0) || Number(obsAfter?.mismatched || 0) !== 0) {
    throw new Error(`Post-correction observation verification failed for ${pair.key}`);
  }
  return { key: pair.key, status: 'corrected', movedObservations: observations.rowCount };
}

async function applyCorrection(db, report, commit) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-stale-ownership-six'))`);
    const initialStates = [];
    for (const pair of CARDMARKET_STALE_OWNERSHIP_SIX) {
      const state = await pairState(db, pair);
      initialStates.push(state.corrected ? 'corrected' : state.stale ? 'stale' : 'other');
    }
    if (initialStates.includes('other')) throw new Error(`Unexpected mixed ownership state: ${initialStates.join(',')}`);
    if (initialStates.includes('stale') && initialStates.includes('corrected')) throw new Error(`Partial ownership correction detected: ${initialStates.join(',')}`);

    const results = [];
    for (const pair of CARDMARKET_STALE_OWNERSHIP_SIX) {
      results.push(await correctPair(db, pair, report.cardmarketCatalogueSha256));
    }

    const movedObservations = results.reduce((sum, row) => sum + Number(row.movedObservations || 0), 0);
    if (commit) await db.query('COMMIT');
    else await db.query('ROLLBACK');
    return { results, movedObservations, mode: initialStates.every((value) => value === 'corrected') ? 'idempotent' : 'correction' };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const report = JSON.parse(await readFile(AUDIT_PATH, 'utf8'));
  assertFrozenAudit(report);
  const commit = process.env.MAPPING_WRITE === 'true';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let output;
  try {
    const result = await applyCorrection(db, report, commit);
    output = {
      status: commit ? 'write_complete' : 'rehearsal_passed',
      productionWrites: commit,
      manifestDigest: CARDMARKET_STALE_OWNERSHIP_SIX_DIGEST,
      correctedPairs: CARDMARKET_STALE_OWNERSHIP_SIX.length,
      ...result,
    };
  } finally { db.release(); await pool.end(); }
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    const output = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  });
}
