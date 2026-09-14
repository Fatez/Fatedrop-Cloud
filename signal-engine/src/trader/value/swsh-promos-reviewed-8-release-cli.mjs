import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import {
  tcgdexDescriptorEvidence,
  providerDescriptorTerms,
  providerDescriptorIsUniqueSubset,
} from './cardmarket-approved-residual-recovery-cli.mjs';
import {
  REVIEWED_SWSH_PROMO_BASE_LANE,
  REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID,
  REVIEWED_SWSH_PROMO_BASE_LANE_REVISION,
} from './cardmarket-reviewed-swsh-promo-base-lane.mjs';

const SET_NAME = 'SWSH Black Star Promos';
const SET_ID = 'swshp';

function collector(value) {
  return normaliseCollectorNumber(String(value ?? '').trim());
}

function isBaselineHolo(variant) {
  return variant?.type === 'holo'
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0;
}

function centralLane(row, lane) {
  const fields = lane === 'holo'
    ? ['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']
    : ['trend', 'avg1', 'avg7', 'avg30'];
  return fields.some((field) => Number(row?.[field]) > 0);
}

function exactCardId(entry) {
  return `${SET_ID}-${String(entry.collectorNumber).toUpperCase()}`;
}

function manifestDigest() {
  const canonical = [...REVIEWED_SWSH_PROMO_BASE_LANE]
    .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId))
    .map((row) => [row.mappingId,row.cardIdentityId,row.sourceRecordId,row.collectorNumber,row.name,row.proof].join('|'))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function assertPinnedExpectations() {
  const expectedCount = Number(process.env.EXPECTED_SWSH_PROMO8_COUNT || 0);
  const expectedExpansion = Number(process.env.EXPECTED_SWSH_PROMO8_EXPANSION || 0);
  const expectedDigest = String(process.env.EXPECTED_SWSH_PROMO8_DIGEST || '').trim();
  if (expectedCount && expectedCount !== REVIEWED_SWSH_PROMO_BASE_LANE.length) {
    throw new Error(`SWSH promo reviewed cohort count drift: expected ${expectedCount}, found ${REVIEWED_SWSH_PROMO_BASE_LANE.length}`);
  }
  if (expectedExpansion && expectedExpansion !== REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID) {
    throw new Error(`SWSH promo expansion drift: expected ${expectedExpansion}, found ${REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID}`);
  }
  const digest = manifestDigest();
  if (expectedDigest && expectedDigest !== digest) throw new Error('SWSH promo reviewed manifest digest drift');
  if (process.env.MAPPING_WRITE === 'true' && (!expectedCount || !expectedExpansion || !expectedDigest)) {
    throw new Error('Production SWSH promo writes require pinned count, expansion and manifest digest');
  }
  return digest;
}

function verifyTcgdexEvidence(entry, card, productById) {
  assert.ok(card, `Pinned TCGdex card missing ${exactCardId(entry)}`);
  assert.ok(rootProductNameMatches(entry.name, card.name), `TCGdex name drift ${exactCardId(entry)}`);
  assert.equal(collector(card.localId), collector(entry.collectorNumber));

  const baseline = (card.variants || []).filter(isBaselineHolo);
  const baselineIds = [...new Set(baseline
    .map((variant) => Number(variant.cardmarketProductId))
    .filter((id) => Number.isSafeInteger(id) && id > 0))]
    .map(String);
  assert.ok(baselineIds.includes(entry.sourceRecordId), `Reviewed product missing from ordinary holo variants ${entry.sourceRecordId}`);

  const reviewedProduct = productById.get(entry.sourceRecordId);
  assert.ok(reviewedProduct, `Reviewed Cardmarket product absent ${entry.sourceRecordId}`);
  assert.equal(Number(reviewedProduct.sourceExpansionId), REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID);
  assert.ok(rootProductNameMatches(entry.name, reviewedProduct.name), `Cardmarket root name conflict ${entry.sourceRecordId}`);

  if (entry.proof === 'phase2_explicit_unstamped_variant') {
    assert.deepEqual(baselineIds, [entry.sourceRecordId], `Phase 2 ordinary product is no longer unique ${entry.sourceRecordId}`);
    const special = (card.variants || []).filter((variant) => !isBaselineHolo(variant) && Number(variant.cardmarketProductId) > 0);
    assert.ok(special.every((variant) => String(variant.cardmarketProductId) !== entry.sourceRecordId), `Special variant reuses ordinary product ${entry.sourceRecordId}`);
    return;
  }

  assert.equal(entry.proof, 'phase3_unique_descriptor_tiebreak');
  assert.ok(baselineIds.length > 1, `Phase 3 ambiguity disappeared unexpectedly ${entry.sourceRecordId}`);
  const tcgdexTerms = tcgdexDescriptorEvidence(card);
  const winners = baselineIds.filter((productId) => {
    const product = productById.get(productId);
    return Boolean(product)
      && Number(product.sourceExpansionId) === REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID
      && rootProductNameMatches(entry.name, product.name)
      && providerDescriptorIsUniqueSubset(providerDescriptorTerms(product.name), tcgdexTerms);
  });
  assert.deepEqual(winners, [entry.sourceRecordId], `Phase 3 descriptor tie-break is no longer unique ${entry.sourceRecordId}`);
}

async function currentMappingState(db, entry, { forUpdate = false } = {}) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const identity = await db.query(`
    SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key
    FROM fatedrop_card_source_mappings m
    WHERE m.source_name='cardmarket' AND m.card_identity_id=$1${lock}`, [entry.cardIdentityId]);
  const source = await db.query(`
    SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key
    FROM fatedrop_card_source_mappings m
    WHERE m.source_name='cardmarket' AND m.source_record_id=$1 AND m.source_variant_key='holo'${lock}`, [entry.sourceRecordId]);

  if (identity.rowCount === 0 && source.rowCount === 0) return 'missing';
  if (identity.rowCount === 1 && source.rowCount === 1) {
    const left = identity.rows[0];
    const right = source.rows[0];
    if (left.id === entry.mappingId
      && left.card_identity_id === entry.cardIdentityId
      && left.source_record_id === entry.sourceRecordId
      && left.source_variant_key === 'holo'
      && right.id === entry.mappingId
      && right.card_identity_id === entry.cardIdentityId) return 'exact_existing';
  }
  throw new Error(`Mapping ownership drift for ${entry.cardIdentityId}/${entry.sourceRecordId}`);
}

async function verifyCanonical(db, entry) {
  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,
      p.name,p.collector_number,s.name AS set_name,rs.classifier_state
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.id=$1`, [entry.cardIdentityId]);
  assert.equal(rows.length, 1, `Missing canonical identity ${entry.cardIdentityId}`);
  const row = rows[0];
  assert.equal(row.variant_code, 'holo');
  assert.equal(row.language_code, 'en');
  assert.equal(row.verification_status, 'verified');
  assert.equal(row.set_name, SET_NAME);
  assert.ok(rootProductNameMatches(entry.name, row.name));
  assert.equal(collector(row.collector_number), collector(entry.collectorNumber));
  assert.ok(!['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(row.classifier_state));
}

export async function buildRelease(db, { repoEvidence, sources } = {}) {
  const candidateDigest = assertPinnedExpectations();
  assert.equal(process.env.TCGDEX_REVISION, REVIEWED_SWSH_PROMO_BASE_LANE_REVISION, 'Pinned TCGdex revision mismatch');
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const set = repo.bySetId.get(SET_ID);
  assert.ok(set && set.setName === SET_NAME, 'Pinned SWSH promo set missing');
  assert.equal(Number(set.cardmarketExpansionId), REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const cardById = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));

  let exactExisting = 0;
  let missing = 0;
  for (const entry of REVIEWED_SWSH_PROMO_BASE_LANE) {
    await verifyCanonical(db, entry);
    verifyTcgdexEvidence(entry, cardById.get(exactCardId(entry)), productById);
    const price = priceById.get(entry.sourceRecordId);
    assert.ok(centralLane(price, 'standard'), `Supported current base-lane price missing ${entry.sourceRecordId}`);
    assert.equal(centralLane(price, 'holo'), false, `Separate holo lane now exists ${entry.sourceRecordId}`);
    const state = await currentMappingState(db, entry);
    if (state === 'exact_existing') exactExisting += 1;
    else missing += 1;
  }

  return Object.freeze({
    status: 'release_verified',
    productionWrites: false,
    candidateDigest,
    source: Object.freeze({
      tcgdexRevision: REVIEWED_SWSH_PROMO_BASE_LANE_REVISION,
      tcgdexSetId: SET_ID,
      cardmarketExpansionId: REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze({ reviewed: 8, exactExisting, missing, ownershipCollisions: 0, currentlyBaseLanePriceable: 8 }),
  });
}

async function persist(db, report) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-swsh-promo8-cardmarket-release'))`);
    let insertedMappings = 0;
    let existingMappings = 0;
    for (const entry of REVIEWED_SWSH_PROMO_BASE_LANE) {
      await verifyCanonical(db, entry);
      const state = await currentMappingState(db, entry, { forUpdate: true });
      if (state === 'exact_existing') {
        existingMappings += 1;
        continue;
      }
      const now = Date.now();
      const result = await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,'holo',$4,$5,$5)
        RETURNING id`, [entry.mappingId,entry.cardIdentityId,entry.sourceRecordId,report.source.cardmarketCatalogueSha256,now]);
      insertedMappings += result.rowCount;
    }
    if (insertedMappings + existingMappings !== REVIEWED_SWSH_PROMO_BASE_LANE.length) throw new Error('SWSH promo mapping persistence count mismatch');
    await db.query('COMMIT');
    return Object.freeze({ insertedMappings, existingMappings });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await buildRelease(db);
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persist(db, report);
      report = Object.freeze({ ...report, status: 'write_complete', productionWrites: true, persistence });
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/swsh-promos-reviewed-8-release.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
