import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import {
  tcgdexDescriptorEvidence,
  providerDescriptorTerms,
  providerDescriptorIsUniqueSubset,
} from './cardmarket-approved-residual-recovery-cli.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';
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

function exactCardId(entry) {
  return `${SET_ID}-${String(entry.collectorNumber).toUpperCase()}`;
}

function candidateDigest(entries) {
  const canonical = [...entries]
    .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId))
    .map((row) => [row.mappingId,row.cardIdentityId,row.sourceRecordId,row.collectorNumber,row.name,row.proof].join('|'))
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

async function verifyCanonicalAndOwnership(db, entry) {
  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,
      p.name,p.collector_number,s.name AS set_name,
      rs.classifier_state
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
  assert.ok(rootProductNameMatches(entry.name, row.name), `Canonical name drift ${entry.cardIdentityId}`);
  assert.equal(collector(row.collector_number), collector(entry.collectorNumber));
  assert.ok(!['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(row.classifier_state));

  const identityMappings = await db.query(`
    SELECT source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket' AND card_identity_id=$1`, [entry.cardIdentityId]);
  assert.equal(identityMappings.rowCount, 0, `Identity already Cardmarket-mapped ${entry.cardIdentityId}`);

  const owners = await db.query(`
    SELECT card_identity_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket' AND source_record_id=$1`, [entry.sourceRecordId]);
  assert.equal(owners.rowCount, 0, `Reviewed source product already owned ${entry.sourceRecordId}`);
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
    const competingSpecial = (card.variants || []).filter((variant) => !isBaselineHolo(variant) && Number(variant.cardmarketProductId) > 0);
    assert.ok(competingSpecial.every((variant) => String(variant.cardmarketProductId) !== entry.sourceRecordId), `Special variant reuses ordinary product ${entry.sourceRecordId}`);
    return;
  }

  assert.equal(entry.proof, 'phase3_unique_descriptor_tiebreak');
  assert.ok(baselineIds.length > 1, `Phase 3 ambiguity disappeared unexpectedly ${entry.sourceRecordId}`);
  const tcgdexTerms = tcgdexDescriptorEvidence(card);
  const winners = baselineIds.filter((productId) => {
    const product = productById.get(productId);
    if (!product) return false;
    if (Number(product.sourceExpansionId) !== REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID) return false;
    if (!rootProductNameMatches(entry.name, product.name)) return false;
    return providerDescriptorIsUniqueSubset(providerDescriptorTerms(product.name), tcgdexTerms);
  });
  assert.deepEqual(winners, [entry.sourceRecordId], `Phase 3 descriptor tie-break is no longer unique ${entry.sourceRecordId}`);
}

export async function rehearse(db, { repoEvidence, sources } = {}) {
  assert.equal(process.env.TCGDEX_REVISION, REVIEWED_SWSH_PROMO_BASE_LANE_REVISION, 'Pinned TCGdex revision mismatch');
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const set = repo.bySetId.get(SET_ID);
  assert.ok(set, 'Pinned SWSH promo set missing');
  assert.equal(set.setName, SET_NAME);
  assert.equal(Number(set.cardmarketExpansionId), REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const cardById = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));

  for (const entry of REVIEWED_SWSH_PROMO_BASE_LANE) {
    await verifyCanonicalAndOwnership(db, entry);
    verifyTcgdexEvidence(entry, cardById.get(exactCardId(entry)), productById);
    const price = priceById.get(entry.sourceRecordId);
    assert.ok(centralLane(price, 'standard'), `Supported current base-lane price missing ${entry.sourceRecordId}`);
    assert.equal(centralLane(price, 'holo'), false, `Separate holo lane now exists; reviewed base-lane policy must stop ${entry.sourceRecordId}`);
  }

  await db.query('BEGIN');
  try {
    const observedAt = Date.now();
    for (const entry of REVIEWED_SWSH_PROMO_BASE_LANE) {
      await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,'holo',$4,$5,$5)`, [
          entry.mappingId, entry.cardIdentityId, entry.sourceRecordId, catalogue.sha256, observedAt,
        ]);
    }

    const batch = await prepareCardmarketDailyPriceGuideBatch({
      store: { pool: async () => db },
      priceGuidePayload: {
        version: Number(snapshot.sourceVersion),
        createdAt: new Date(snapshot.sourceEffectiveAt).toISOString(),
        priceGuides: snapshot.priceGuides,
      },
      observedAt,
    });
    const identities = new Set(REVIEWED_SWSH_PROMO_BASE_LANE.map((row) => row.cardIdentityId));
    const observations = batch.observations.filter((row) => identities.has(row.cardIdentityId));
    assert.equal(observations.length, REVIEWED_SWSH_PROMO_BASE_LANE.length, 'Every reviewed SWSH promo must produce one observation');
    assert.equal(new Set(observations.map((row) => row.cardIdentityId)).size, REVIEWED_SWSH_PROMO_BASE_LANE.length);
    for (const observation of observations) {
      assert.equal(observation.sourceVariantKey, 'holo');
      assert.equal(observation.marketSegmentKey, 'holo');
      assert.ok(['marketPrice','trendPrice','avg1d','avg7d','avg30d'].some((field) => Number(observation[field]) > 0));
    }

    return Object.freeze({
      status: 'rehearsal_passed',
      productionWrites: false,
      counts: Object.freeze({ reviewed: 8, tempMappingsInserted: 8, observationsProduced: observations.length, ownershipCollisions: 0 }),
      candidateDigest: candidateDigest(REVIEWED_SWSH_PROMO_BASE_LANE),
      source: Object.freeze({
        tcgdexRevision: REVIEWED_SWSH_PROMO_BASE_LANE_REVISION,
        tcgdexSetId: SET_ID,
        cardmarketExpansionId: REVIEWED_SWSH_PROMO_BASE_LANE_EXPANSION_ID,
        cardmarketCatalogueSha256: catalogue.sha256,
        cardmarketPriceGuideSha256: guide.sha256,
        sourceSnapshotId: snapshot.sourceSnapshotId,
      }),
      observations: Object.freeze(observations.map((row) => Object.freeze({
        cardIdentityId: row.cardIdentityId,
        sourceRecordId: row.sourceRecordId,
        sourceVariantKey: row.sourceVariantKey,
        marketSegmentKey: row.marketSegmentKey,
        marketPrice: row.marketPrice,
        trendPrice: row.trendPrice,
        avg1d: row.avg1d,
        avg7d: row.avg7d,
        avg30d: row.avg30d,
      }))),
    });
  } finally {
    await db.query('ROLLBACK');
  }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  let report;
  try {
    report = await rehearse(db);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/swsh-promos-reviewed-8-rehearsal.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, observations: undefined }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
