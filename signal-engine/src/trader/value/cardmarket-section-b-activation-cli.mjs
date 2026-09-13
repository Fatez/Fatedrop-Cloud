import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { build as buildPrimary } from './cardmarket-resolution-aware-root-recovery-cli.mjs';
import { build as buildSecondary } from './cardmarket-relaxed-secondary-recovery-cli.mjs';

function requiredInt(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
function requiredText(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function sourceKey(row) {
  return `${row.sourceRecordId}|${row.sourceVariantKey}`;
}

export function combineCandidates(primary, secondary) {
  const rows = [...primary, ...secondary];
  const identities = new Set();
  const sources = new Set();
  for (const row of rows) {
    if (identities.has(row.cardIdentityId)) throw new Error(`Duplicate canonical identity across recovery lanes: ${row.cardIdentityId}`);
    identities.add(row.cardIdentityId);
    const key = sourceKey(row);
    if (sources.has(key)) throw new Error(`Duplicate Cardmarket source key across recovery lanes: ${key}`);
    sources.add(key);
  }
  return rows.sort((a, b) => a.cardIdentityId.localeCompare(b.cardIdentityId));
}

function assertPinnedReports(primary, secondary) {
  const expectedSectionB = requiredInt('EXPECTED_SECTION_B');
  const expectedPrimary = requiredInt('EXPECTED_PRIMARY_SAFE');
  const expectedNoRoot = requiredInt('EXPECTED_NO_ROOT');
  const expectedSecondary = requiredInt('EXPECTED_SECONDARY_SAFE');
  const expectedCombined = requiredInt('EXPECTED_COMBINED_SAFE');
  const expectedCatalogue = requiredText('EXPECTED_CARDMARKET_CATALOGUE_SHA256');
  const expectedGuide = requiredText('EXPECTED_CARDMARKET_PRICE_GUIDE_SHA256');

  if (primary.status !== 'audit_complete' || secondary.status !== 'audit_complete') throw new Error('Recovery reports must both be complete read-only audits');
  if (primary.productionWrites !== false || secondary.productionWrites !== false) throw new Error('Recovery reports unexpectedly performed writes');
  if (primary.counts.sectionB !== expectedSectionB) throw new Error(`Section B drift: expected ${expectedSectionB}, found ${primary.counts.sectionB}`);
  if (primary.counts.safeExactMappings !== expectedPrimary) throw new Error(`Primary safe-count drift: expected ${expectedPrimary}, found ${primary.counts.safeExactMappings}`);
  if ((primary.reasons.HOLD_NO_ROOT_CARDMARKET_PRODUCT || 0) !== expectedNoRoot) throw new Error(`Primary no-root drift: expected ${expectedNoRoot}, found ${primary.reasons.HOLD_NO_ROOT_CARDMARKET_PRODUCT || 0}`);
  if (secondary.counts.inputNoRoot !== expectedNoRoot) throw new Error(`Secondary input drift: expected ${expectedNoRoot}, found ${secondary.counts.inputNoRoot}`);
  if (secondary.counts.safeExactMappings !== expectedSecondary) throw new Error(`Secondary safe-count drift: expected ${expectedSecondary}, found ${secondary.counts.safeExactMappings}`);
  if (expectedPrimary + expectedSecondary !== expectedCombined) throw new Error('Pinned combined count is internally inconsistent');
  for (const report of [primary, secondary]) {
    if (report.source.cardmarketCatalogueSha256 !== expectedCatalogue) throw new Error('Cardmarket catalogue snapshot drift');
    if (report.source.cardmarketPriceGuideSha256 !== expectedGuide) throw new Error('Cardmarket price-guide snapshot drift');
  }
  const combined = combineCandidates(primary.candidates, secondary.candidates);
  if (combined.length !== expectedCombined) throw new Error(`Combined safe-count drift: expected ${expectedCombined}, found ${combined.length}`);
  return combined;
}

async function persistCombined(db, candidates, sourceVersion) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-section-b-activation'))`);
    let insertedMappings = 0;
    for (const row of candidates) {
      const target = await db.query(`
        SELECT i.id,i.variant_code,i.language_code,i.verification_status,rs.classifier_state
        FROM fatedrop_card_identities i
        LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
        WHERE i.id=$1 FOR UPDATE`, [row.cardIdentityId]);
      const current = target.rows[0];
      if (!current || current.verification_status !== 'verified' || current.language_code !== 'en' || current.variant_code !== row.variantCode) throw new Error(`Canonical identity changed: ${row.cardIdentityId}`);
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(current.classifier_state)) throw new Error(`Resolution state changed: ${row.cardIdentityId}`);

      const canonical = await db.query(`SELECT source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`, [row.cardIdentityId]);
      if (canonical.rowCount) throw new Error(`Identity already mapped: ${row.cardIdentityId}`);

      const source = await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`, [row.sourceRecordId,row.sourceVariantKey]);
      if (source.rowCount) throw new Error(`Source key already owned: ${row.sourceRecordId}/${row.sourceVariantKey}`);

      const now = Date.now();
      const result = await db.query(`INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) RETURNING id`, [row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,sourceVersion,now]);
      insertedMappings += result.rowCount;
    }
    await db.query('COMMIT');
    return { insertedMappings };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (process.env.ACTIVATE !== 'true') throw new Error('ACTIVATE=true is required');
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');

  const repoEvidence = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const [catalogue, guide] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const sources = { catalogue, guide };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    const primary = await buildPrimary(db, { sources, repoEvidence });
    const secondary = await buildSecondary(db, { sources, repoEvidence });
    const candidates = assertPinnedReports(primary, secondary);
    const persistence = await persistCombined(db, candidates, catalogue.artifact.sha256);
    report = {
      status: 'write_complete',
      productionWrites: true,
      priceWrites: false,
      source: primary.source,
      primary: primary.counts,
      secondary: secondary.counts,
      combinedSafeMappings: candidates.length,
      persistence,
    };
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, priceWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }

  await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-section-b-activation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
