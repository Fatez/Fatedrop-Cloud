import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import {
  REVIEWED_SV_BASE_LANE,
  REVIEWED_SV_BASE_LANE_EXPANSION_ID,
  REVIEWED_SV_BASE_LANE_MANIFEST_DIGEST,
  REVIEWED_SV_BASE_LANE_REVISION,
  validateReviewedSvBaseLaneMapping,
  validateReviewedSvBaseLaneMappings,
} from './cardmarket-reviewed-sv-base-lane.mjs';

const SET_ID = 'sv01';
const SET_NAME = 'Scarlet & Violet';

function collector(value) {
  return normaliseCollectorNumber(String(value ?? '').trim());
}

function centralLane(row, lane) {
  const fields = lane === 'holo'
    ? ['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo']
    : ['trend', 'avg1', 'avg7', 'avg30'];
  return fields.some((field) => Number(row?.[field]) > 0);
}

function isBaselineHolo(variant) {
  return variant?.type === 'holo'
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0;
}

function assertPins() {
  assert.equal(Number(process.env.EXPECTED_SV70_COUNT), REVIEWED_SV_BASE_LANE.length);
  assert.equal(Number(process.env.EXPECTED_SV70_EXPANSION), REVIEWED_SV_BASE_LANE_EXPANSION_ID);
  assert.equal(process.env.EXPECTED_SV70_DIGEST, REVIEWED_SV_BASE_LANE_MANIFEST_DIGEST);
  assert.equal(process.env.TCGDEX_REVISION, REVIEWED_SV_BASE_LANE_REVISION);
}

async function canonicalRow(db, entry, lock = false) {
  const result = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,
      p.name,p.collector_number,s.name AS set_name,rs.classifier_state
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.id=$1${lock ? ' FOR UPDATE OF i' : ''}`, [entry.cardIdentityId]);
  assert.equal(result.rowCount, 1, `Missing identity ${entry.cardIdentityId}`);
  const row = result.rows[0];
  assert.equal(row.variant_code, 'holo');
  assert.equal(row.language_code, 'en');
  assert.equal(row.verification_status, 'verified');
  assert.equal(row.set_name, SET_NAME);
  assert.ok(rootProductNameMatches(entry.name, row.name), `Canonical name drift ${entry.cardIdentityId}`);
  assert.equal(collector(row.collector_number), collector(entry.collectorNumber));
  assert.ok(!['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(row.classifier_state));
}

async function mappingState(db, entry, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const result = await db.query(`
    SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,
      i.variant_code AS canonical_variant_code,i.language_code,i.verification_status
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
    WHERE m.source_name='cardmarket'
      AND (m.card_identity_id=$1 OR m.source_record_id=$2)${suffix}`,
    [entry.cardIdentityId, entry.sourceRecordId]);
  if (result.rowCount === 0) return { state: 'missing', rows: [] };
  if (result.rowCount === 1 && validateReviewedSvBaseLaneMapping(result.rows[0])) {
    return { state: 'exact_existing', rows: result.rows };
  }
  throw new Error(`Mapping ownership drift ${entry.cardIdentityId}/${entry.sourceRecordId}`);
}

export function verifyEvidence(entry, card, productById, priceById) {
  assert.ok(card, `Pinned TCGdex card missing ${entry.tcgdexCardId}`);
  assert.ok(rootProductNameMatches(entry.name, card.name), `TCGdex name drift ${entry.tcgdexCardId}`);
  assert.equal(collector(card.localId), collector(entry.collectorNumber));
  assert.equal(card.tcgdexCardId, entry.tcgdexCardId, 'TCGdex card identity drift');
  // The audited proof is a root-level product plus one explicit ordinary holo
  // variant. It does not require a variant-level thirdParty product ID.
  assert.equal(String(getRootCardmarketProductId(card)), entry.sourceRecordId,
    `Root Cardmarket product drift ${entry.sourceRecordId}`);
  assert.equal(card.variants?.length, 1, 'Expected sole ordinary holo finish');
  assert.ok(isBaselineHolo(card.variants[0]), 'Expected sole ordinary holo finish');
  const variantProduct = card.variants[0].cardmarketProductId;
  if (variantProduct != null) {
    assert.equal(String(variantProduct), entry.sourceRecordId, 'Variant/root product conflict');
  }
  const product = productById.get(entry.sourceRecordId);
  assert.ok(product, `Cardmarket product missing ${entry.sourceRecordId}`);
  assert.equal(Number(product.sourceExpansionId), REVIEWED_SV_BASE_LANE_EXPANSION_ID);
  if (entry.proof === 'professor_label_sole_ordinary_holo_finish') {
    const labels = {
      '240': "Professor's Research - Professor Sada",
      '241': "Professor's Research - Professor Turo",
    };
    assert.ok(labels[entry.collectorNumber], 'Unreviewed Professor collector number');
    assert.equal(product.name, labels[entry.collectorNumber], 'Professor provider label drift');
  } else {
    assert.equal(entry.proof, 'root_sole_ordinary_holo_finish');
    assert.ok(rootProductNameMatches(entry.name, product.name), 'Cardmarket product name drift');
  }
  const price = priceById.get(entry.sourceRecordId);
  assert.ok(centralLane(price, 'standard'), `Current base-lane price missing ${entry.sourceRecordId}`);
  assert.equal(centralLane(price, 'holo'), false, `Separate holo lane now exists ${entry.sourceRecordId}`);
}

async function auditObservations(db) {
  const ids = REVIEWED_SV_BASE_LANE.map((row) => row.cardIdentityId);
  const result = await db.query(`
    SELECT card_identity_id,MAX(observed_at) AS latest
    FROM fatedrop_market_observations
    WHERE source_name='cardmarket' AND market_segment_key='holo'
      AND card_identity_id=ANY($1::text[])
      AND COALESCE(market_price,trend_price,avg_1d,avg_7d,avg_30d) > 0
    GROUP BY card_identity_id`, [ids]);
  assert.equal(result.rowCount, REVIEWED_SV_BASE_LANE.length, 'Post-write audit did not find 70 priced holo identities');
  return result.rowCount;
}

export async function release(db, { repoEvidence, sources } = {}) {
  assertPins();
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const set = repo.bySetId.get(SET_ID);
  assert.ok(set, 'Pinned Scarlet & Violet set missing');
  assert.equal(set.setName, SET_NAME);
  assert.equal(Number(set.cardmarketExpansionId), REVIEWED_SV_BASE_LANE_EXPANSION_ID);
  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const cardById = new Map(set.cards.map((row) => [row.tcgdexCardId, row]));
  let exactExisting = 0;
  let missing = 0;
  for (const entry of REVIEWED_SV_BASE_LANE) {
    await canonicalRow(db, entry);
    verifyEvidence(entry, cardById.get(entry.tcgdexCardId), productById, priceById);
    const current = await mappingState(db, entry);
    current.state === 'exact_existing' ? exactExisting++ : missing++;
  }
  return {
    status: 'release_verified',
    productionWrites: false,
    source: {
      tcgdexRevision: REVIEWED_SV_BASE_LANE_REVISION,
      cardmarketExpansionId: REVIEWED_SV_BASE_LANE_EXPANSION_ID,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    },
    counts: { reviewed: 70, exactExisting, missing, ownershipCollisions: 0, currentlyPriceable: 70 },
  };
}

async function persist(db, report) {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-sv70-cardmarket-release'))`);
    let insertedMappings = 0;
    let existingMappings = 0;
    for (const entry of REVIEWED_SV_BASE_LANE) {
      await canonicalRow(db, entry, true);
      const current = await mappingState(db, entry, true);
      if (current.state === 'exact_existing') { existingMappings++; continue; }
      const now = Date.now();
      const result = await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,'holo',$4,$5,$5) RETURNING id`,
        [entry.mappingId,entry.cardIdentityId,entry.sourceRecordId,report.source.cardmarketCatalogueSha256,now]);
      insertedMappings += result.rowCount;
    }
    assert.equal(insertedMappings + existingMappings, REVIEWED_SV_BASE_LANE.length);
    const rows = await db.query(`
      SELECT m.id,m.card_identity_id,m.source_record_id,m.source_variant_key,
        i.variant_code AS canonical_variant_code,i.language_code,i.verification_status
      FROM fatedrop_card_source_mappings m
      JOIN fatedrop_card_identities i ON i.id=m.card_identity_id
      WHERE m.source_name='cardmarket' AND m.source_record_id=ANY($1::text[])`,
      [REVIEWED_SV_BASE_LANE.map((row) => row.sourceRecordId)]);
    assert.equal(validateReviewedSvBaseLaneMappings(rows.rows).size, 70, 'Persisted cohort failed frozen validation');
    await db.query('COMMIT');
    return { insertedMappings, existingMappings };
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
    report = await release(db);
    if (process.env.MAPPING_WRITE === 'true') {
      report.persistence = await persist(db, report);
      report.productionWrites = true;
      report.status = 'write_complete';
    }
    if (process.env.POST_WRITE_AUDIT === 'true') {
      report.counts.pricedAfterWrite = await auditObservations(db);
      report.status = 'post_write_verified';
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/sv70-production-activation.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
