import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { validateJapaneseCatalogueArtifact } from '../catalogue/japanese-catalogue-evidence.mjs';

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function envInt(name) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be an explicit non-negative integer`);
  return value;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stableId(prefix, parts) { return `${prefix}_${sha256(parts.join('|')).slice(0, 24)}`; }
function batches(rows, size = 300) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
function column(source, db, cast = null) { return { source, db, cast, json: cast === 'jsonb' }; }

async function insertRows(client, table, rows, columns, conflict = 'DO NOTHING') {
  let affected = 0;
  for (const batch of batches(rows || [])) {
    if (!batch.length) continue;
    const params = [];
    const tuples = batch.map((row) => `(${columns.map((col) => {
      let value = row[col.source];
      if (col.json && value != null) value = JSON.stringify(value);
      params.push(value ?? null);
      return `$${params.length}${col.cast ? `::${col.cast}` : ''}`;
    }).join(',')})`);
    const sql = `INSERT INTO ${table} (${columns.map((col) => col.db).join(',')}) VALUES ${tuples.join(',')} ON CONFLICT ${conflict}`;
    const result = await client.query(sql, params);
    affected += result.rowCount || 0;
  }
  return affected;
}

const COLS = Object.freeze({
  tcgs: [column('id','id'),column('code','code'),column('name','name'),column('status','status'),column('createdAt','created_at'),column('updatedAt','updated_at')],
  series: [column('id','id'),column('tcgId','tcg_id'),column('code','code'),column('name','name'),column('verificationStatus','verification_status'),column('verifiedAt','verified_at'),column('createdAt','created_at'),column('updatedAt','updated_at')],
  sets: [column('id','id'),column('tcgId','tcg_id'),column('seriesId','series_id'),column('code','code'),column('name','name'),column('printedTotal','printed_total'),column('total','total'),column('releasedAt','released_at'),column('createdAt','created_at'),column('updatedAt','updated_at'),column('verificationStatus','verification_status'),column('verifiedAt','verified_at')],
  setSourceMappings: [column('id','id'),column('setId','set_id'),column('sourceName','source_name'),column('sourceRecordId','source_record_id'),column('sourceSeriesCode','source_series_code'),column('sourceUrl','source_url'),column('sourceVersion','source_version'),column('firstObservedAt','first_observed_at'),column('lastObservedAt','last_observed_at')],
  printings: [column('id','id'),column('tcgId','tcg_id'),column('seriesId','series_id'),column('setId','set_id'),column('printingCode','printing_code'),column('collectorNumber','collector_number'),column('name','name'),column('rarity','rarity'),column('supertype','supertype'),column('subtypes','subtypes','jsonb'),column('nationalDexNumbers','national_dex_numbers','jsonb'),column('attributes','attributes','jsonb'),column('createdAt','created_at'),column('updatedAt','updated_at'),column('verificationStatus','verification_status'),column('verifiedAt','verified_at')],
  cardIdentities: [column('id','id'),column('canonicalKey','canonical_key'),column('tcgId','tcg_id'),column('seriesId','series_id'),column('setId','set_id'),column('printingId','printing_id'),column('collectorNumber','collector_number'),column('variantCode','variant_code'),column('languageCode','language_code'),column('verificationStatus','verification_status'),column('verifiedAt','verified_at'),column('createdAt','created_at'),column('updatedAt','updated_at')],
  cardSourceMappings: [column('id','id'),column('cardIdentityId','card_identity_id'),column('sourceName','source_name'),column('sourceRecordId','source_record_id'),column('sourceVariantKey','source_variant_key'),column('sourceUrl','source_url'),column('sourceVersion','source_version'),column('firstObservedAt','first_observed_at'),column('lastObservedAt','last_observed_at')],
  cardProvenance: [column('id','id'),column('cardIdentityId','card_identity_id'),column('sourceName','source_name'),column('sourceRecordId','source_record_id'),column('sourceVariantKey','source_variant_key'),column('sourceUrl','source_url'),column('observedAt','observed_at'),column('evidenceStatus','evidence_status'),column('evidenceJson','evidence_json','jsonb'),column('createdAt','created_at')],
  catalogueSnapshots: [column('id','id'),column('runId','run_id'),column('provider','provider'),column('scopeType','scope_type'),column('sourceLocator','source_locator'),column('sourceRecordId','source_record_id'),column('setCode','set_code'),column('observedAt','observed_at'),column('payloadSha256','payload_sha256'),column('artifactSha256','artifact_sha256'),column('rawPayloadText','raw_payload_text'),column('createdAt','created_at')],
  variantSnapshots: [column('id','id'),column('cardIdentityId','card_identity_id'),column('provider','provider'),column('sourceLocator','source_locator'),column('requestFingerprint','request_fingerprint'),column('observedAt','observed_at'),column('payloadSha256','payload_sha256'),column('artifactSha256','artifact_sha256'),column('rawPayloadText','raw_payload_text'),column('createdAt','created_at')],
  evidenceFlags: [column('id','id'),column('runId','run_id'),column('flagType','flag_type'),column('provider','provider'),column('setCode','set_code'),column('sourceRecordId','source_record_id'),column('cardIdentityId','card_identity_id'),column('evidenceSha256','evidence_sha256'),column('sourceLocator','source_locator'),column('detail','detail','jsonb'),column('active','active'),column('createdAt','created_at'),column('updatedAt','updated_at')],
});

function snapshotIndex(artifact) {
  const map = new Map();
  for (const snap of artifact.rows.variantSnapshots || []) map.set(`${snap.cardIdentityId}|${snap.provider}|${snap.payloadSha256}`, snap.id);
  return map;
}
function reviewRows(artifact) {
  const snapshots = snapshotIndex(artifact);
  return (artifact.rows.variantReviews || []).map((row) => {
    const snapshotId = snapshots.get(`${row.cardIdentityId}|${row.provider}|${row.evidenceSnapshotSha256}`);
    if (!snapshotId) throw new Error(`review snapshot missing for ${row.cardIdentityId}:${row.provider}`);
    return { id: row.id, snapshotId, cardIdentityId: row.cardIdentityId, finish: row.finish, markerType: row.markerType || 'none', language: row.language, edition: row.edition, observedFinish: row.observedFinish, verdict: row.verdict, basis: row.basis, reviewReference: row.reviewReference, reviewer: row.reviewer, approvalState: 'approved', reviewedAt: row.reviewedAt, createdAt: row.createdAt };
  });
}
function firstEvidenceSha(row) {
  const refs = Array.isArray(row.evidenceReferences) ? row.evidenceReferences : [];
  return refs.map((entry) => String(entry?.snapshotSha256 || '')).find((value) => /^[0-9a-f]{64}$/.test(value)) || null;
}
function stateRows(artifact) {
  return (artifact.rows.variantStates || []).map((row) => ({ cardIdentityId: row.cardIdentityId, finish: row.finish, markerType: row.markerType || 'none', language: row.language, edition: row.edition, classifierState: row.state, reason: row.reason, evidenceSha256: firstEvidenceSha(row), reviewReference: row.resolutionReference || artifact.reviewReference, classifiedAt: row.lastClassifiedAt || artifact.verifiedAt, updatedAt: row.updatedAt || artifact.verifiedAt }));
}
function holdRows(artifact) {
  return (artifact.rows.auditHolds || []).map((row) => ({ cardIdentityId: row.cardIdentityId, finish: row.finish, markerType: row.markerType || 'none', reason: row.reason, evidenceSha256: firstEvidenceSha(row), active: row.active !== false, createdAt: row.createdAt, updatedAt: row.updatedAt, resolvedAt: null }));
}
function invalidFlagRows(artifact) {
  return stateRows(artifact).filter((row) => row.classifierState === 'INVALID_CATALOGUE_ENTRY').map((row) => ({ id: stableId('fdcatflag', [artifact.runId, row.cardIdentityId, 'invalid_catalogue_entry']), cardIdentityId: row.cardIdentityId, flagType: 'invalid_catalogue_entry', reason: row.reason, evidenceSha256: row.evidenceSha256, reviewReference: row.reviewReference, active: true, createdAt: artifact.verifiedAt, resolvedAt: null }));
}

const REVIEW_COLS = [column('id','id'),column('snapshotId','snapshot_id'),column('cardIdentityId','card_identity_id'),column('finish','finish'),column('markerType','marker_type'),column('language','language'),column('edition','edition'),column('observedFinish','observed_finish'),column('verdict','verdict'),column('basis','basis'),column('reviewReference','review_reference'),column('reviewer','reviewer'),column('approvalState','approval_state'),column('reviewedAt','reviewed_at'),column('createdAt','created_at')];
const STATE_COLS = [column('cardIdentityId','card_identity_id'),column('finish','finish'),column('markerType','marker_type'),column('language','language'),column('edition','edition'),column('classifierState','classifier_state'),column('reason','reason'),column('evidenceSha256','evidence_sha256'),column('reviewReference','review_reference'),column('classifiedAt','classified_at'),column('updatedAt','updated_at')];
const HOLD_COLS = [column('cardIdentityId','card_identity_id'),column('finish','finish'),column('markerType','marker_type'),column('reason','reason'),column('evidenceSha256','evidence_sha256'),column('active','active'),column('createdAt','created_at'),column('updatedAt','updated_at'),column('resolvedAt','resolved_at')];
const INVALID_COLS = [column('id','id'),column('cardIdentityId','card_identity_id'),column('flagType','flag_type'),column('reason','reason'),column('evidenceSha256','evidence_sha256'),column('reviewReference','review_reference'),column('active','active'),column('createdAt','created_at'),column('resolvedAt','resolved_at')];

function assertPins(artifact, artifactSha256) {
  const expected = { sets: envInt('EXPECTED_JAPANESE_SETS'), printings: envInt('EXPECTED_JAPANESE_PRINTINGS'), cardIdentities: envInt('EXPECTED_JAPANESE_IDENTITIES'), variantStates: envInt('EXPECTED_JAPANESE_STATES'), unresolved: envInt('EXPECTED_JAPANESE_UNRESOLVED') };
  for (const key of ['sets','printings','cardIdentities','variantStates']) if (artifact.counts?.[key] !== expected[key]) throw new Error(`pinned count mismatch ${key}: expected=${expected[key]} actual=${artifact.counts?.[key]}`);
  if (artifact.audit?.variantsByState?.UNRESOLVED_EVIDENCE !== expected.unresolved) throw new Error(`pinned unresolved mismatch: expected=${expected.unresolved} actual=${artifact.audit?.variantsByState?.UNRESOLVED_EVIDENCE}`);
  if (String(process.env.EXPECTED_JAPANESE_RUN_ID || '') !== artifact.runId) throw new Error('EXPECTED_JAPANESE_RUN_ID does not match artifact');
  if (String(process.env.EXPECTED_JAPANESE_ARTIFACT_SHA256 || '').toLowerCase() !== artifactSha256) throw new Error('EXPECTED_JAPANESE_ARTIFACT_SHA256 does not match artifact');
}

async function persistArtifact(artifact, artifactSha256) {
  if (process.env.ALLOW_JAPANESE_CATALOGUE_WRITE !== 'true') throw new Error('ALLOW_JAPANESE_CATALOGUE_WRITE=true is required');
  validateProductionTarget(process.env.DATABASE_URL);
  assertPins(artifact, artifactSha256);
  const reviews = reviewRows(artifact), states = stateRows(artifact), holds = holdRows(artifact), invalidFlags = invalidFlagRows(artifact);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const inserted = {};
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT COUNT(*)::int AS count FROM fatedrop_card_identities WHERE language_code='ja'");
    if (existing.rows[0].count !== 0) throw new Error(`Japanese identities already exist (${existing.rows[0].count}); initial activation refuses overwrite`);
    inserted.tcgs = await insertRows(client, 'fatedrop_tcgs', artifact.rows.tcgs, COLS.tcgs);
    inserted.series = await insertRows(client, 'fatedrop_card_series', artifact.rows.series, COLS.series);
    inserted.sets = await insertRows(client, 'fatedrop_card_sets', artifact.rows.sets, COLS.sets);
    inserted.setSourceMappings = await insertRows(client, 'fatedrop_card_set_source_mappings', artifact.rows.setSourceMappings, COLS.setSourceMappings);
    inserted.printings = await insertRows(client, 'fatedrop_card_printings', artifact.rows.printings, COLS.printings);
    inserted.cardIdentities = await insertRows(client, 'fatedrop_card_identities', artifact.rows.cardIdentities, COLS.cardIdentities);
    inserted.cardSourceMappings = await insertRows(client, 'fatedrop_card_source_mappings', artifact.rows.cardSourceMappings, COLS.cardSourceMappings);
    inserted.cardProvenance = await insertRows(client, 'fatedrop_card_provenance', artifact.rows.cardProvenance, COLS.cardProvenance);
    inserted.catalogueSnapshots = await insertRows(client, 'fatedrop_catalogue_evidence_snapshots', artifact.rows.catalogueSnapshots, COLS.catalogueSnapshots);
    inserted.variantSnapshots = await insertRows(client, 'fatedrop_variant_evidence_snapshots', artifact.rows.variantSnapshots, COLS.variantSnapshots);
    inserted.variantReviews = await insertRows(client, 'fatedrop_variant_evidence_reviews', reviews, REVIEW_COLS);
    inserted.variantStates = await insertRows(client, 'fatedrop_variant_resolution_state', states, STATE_COLS);
    inserted.auditHolds = await insertRows(client, 'fatedrop_variant_audit_hold', holds, HOLD_COLS);
    inserted.invalidFlags = await insertRows(client, 'fatedrop_catalogue_audit_flags', invalidFlags, INVALID_COLS);
    inserted.evidenceFlags = await insertRows(client, 'fatedrop_evidence_audit_flags', artifact.rows.evidenceFlags, COLS.evidenceFlags);
    const identityCheck = await client.query("SELECT COUNT(*)::int AS count, COUNT(DISTINCT printing_id)::int AS printings, COUNT(DISTINCT set_id)::int AS sets FROM fatedrop_card_identities WHERE language_code='ja'");
    const stateCheck = await client.query("SELECT s.classifier_state, COUNT(*)::int AS count FROM fatedrop_variant_resolution_state s JOIN fatedrop_card_identities i ON i.id=s.card_identity_id WHERE i.language_code='ja' GROUP BY s.classifier_state");
    const gotStates = Object.fromEntries(stateCheck.rows.map((row) => [row.classifier_state, row.count]));
    const expectedStates = artifact.audit.variantsByState || {};
    if (identityCheck.rows[0].count !== artifact.counts.cardIdentities) throw new Error(`post-write identity mismatch ${identityCheck.rows[0].count}/${artifact.counts.cardIdentities}`);
    if (identityCheck.rows[0].printings !== artifact.counts.printings) throw new Error(`post-write printing mismatch ${identityCheck.rows[0].printings}/${artifact.counts.printings}`);
    if (identityCheck.rows[0].sets !== artifact.counts.sets) throw new Error(`post-write set mismatch ${identityCheck.rows[0].sets}/${artifact.counts.sets}`);
    for (const state of ['ACTIVE_PRICED','ACTIVE_UNPRICED','INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE']) if ((gotStates[state] || 0) !== (expectedStates[state] || 0)) throw new Error(`post-write state mismatch ${state}: ${gotStates[state] || 0}/${expectedStates[state] || 0}`);
    await client.query('COMMIT');
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const artifactPath = resolve(arg('artifact') || 'japanese-catalogue-artifact.json');
  const reportPath = resolve(arg('report') || 'japanese-catalogue-persist-report.json');
  const mode = arg('mode', process.env.JAPANESE_CATALOGUE_MODE || 'dry-run');
  const raw = await readFile(artifactPath);
  const artifactSha256 = sha256(raw);
  const artifact = validateJapaneseCatalogueArtifact(JSON.parse(raw.toString('utf8')));
  const report = { status: 'validated', mode, runId: artifact.runId, artifactSha256, productionWrites: false, counts: artifact.counts, audit: artifact.audit };
  try {
    reviewRows(artifact);
    if (mode === 'persist') { report.inserted = await persistArtifact(artifact, artifactSha256); report.status = 'complete'; report.productionWrites = true; }
    else if (mode !== 'dry-run') throw new Error('mode must be dry-run or persist');
  } catch (error) {
    report.status = 'blocked'; report.productionWrites = false; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error?.stack || error?.message || String(error)); process.exitCode = 1; });
