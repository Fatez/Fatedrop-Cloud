import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import {
  ROOT_FINISH_POLICY,
  assessBaselineFinishEvidence,
  getRootCardmarketProductId,
  rootProductNameMatches,
} from './cardmarket-tcgdex-root-evidence.mjs';

const key = (...parts) => parts.join('|');
const stableId = (prefix, parts) => `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;

export async function build(db, { repoEvidence, sources } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    (sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue()),
    (sources?.guide ?? fetchCardmarketPokemonPriceGuide()),
  ]);
  const productById = new Map(products.map((product) => [String(product.sourceRecordId), product]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id, i.variant_code, p.name, p.collector_number,
           array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
    GROUP BY i.id,i.variant_code,p.name,p.collector_number
    ORDER BY i.id`);

  const { rows: existing } = await db.query(`
    SELECT card_identity_id, source_record_id, source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const existingSource = new Map(existing.map((row) => [key(row.source_record_id, row.source_variant_key), row.card_identity_id]));

  const counts = {
    eligible: identities.length,
    singleTcgdexLink: 0,
    withRootProductId: 0,
    productExists: 0,
    nameCompatible: 0,
    baselineFinishProven: 0,
    priceable: 0,
    preBatchSafe: 0,
    safeExactMappings: 0,
    batchConflictKeys: 0,
    batchHeldCandidates: 0,
  };
  const reasons = {};
  const raw = [];
  const reason = (name) => { reasons[name] = (reasons[name] || 0) + 1; };

  for (const identity of identities) {
    if (!Array.isArray(identity.tcgdex_card_ids) || identity.tcgdex_card_ids.length !== 1) {
      reason('multiple_tcgdex_card_links');
      continue;
    }
    counts.singleTcgdexLink += 1;
    const tcgdexCardId = identity.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    if (!card) { reason('missing_tcgdex_card'); continue; }

    const rootProductId = getRootCardmarketProductId(card);
    if (!rootProductId) { reason('no_root_cardmarket_product_id'); continue; }
    counts.withRootProductId += 1;

    const sourceRecordId = String(rootProductId);
    const product = productById.get(sourceRecordId);
    if (!product) { reason('root_product_absent_from_official_catalogue'); continue; }
    counts.productExists += 1;
    if (!rootProductNameMatches(identity.name, product.name)) { reason('root_product_name_conflict'); continue; }
    counts.nameCompatible += 1;

    const finishEvidence = assessBaselineFinishEvidence(card, identity.variant_code, rootProductId);
    if (!finishEvidence.ok) { reason(finishEvidence.reason); continue; }
    counts.baselineFinishProven += 1;

    const policy = ROOT_FINISH_POLICY[identity.variant_code];
    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, policy.priceLane)) {
      reason('no_meaningful_price_lane');
      continue;
    }
    counts.priceable += 1;

    const sourceKey = key(sourceRecordId, policy.sourceVariantKey);
    const owner = existingSource.get(sourceKey);
    if (owner && owner !== identity.id) { reason('source_owned'); continue; }

    raw.push({
      id: stableId('fdcardmap', [identity.id, 'cardmarket', sourceRecordId, policy.sourceVariantKey]),
      cardIdentityId: identity.id,
      name: identity.name,
      collectorNumber: identity.collector_number,
      variantCode: identity.variant_code,
      tcgdexCardId,
      sourceRecordId,
      sourceVariantKey: policy.sourceVariantKey,
      sourceVersion: catalogue.sha256,
      cardmarketProductName: product.name,
      proof: {
        method: 'tcgdex_root_product_plus_explicit_baseline_finish',
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        baselineCount: finishEvidence.baselineCount,
        explicitBaselineProductIds: finishEvidence.explicitProductIds,
      },
    });
  }

  counts.preBatchSafe = raw.length;
  const owners = new Map();
  const badKeys = new Set();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
    if (owners.has(sourceKey) && owners.get(sourceKey) !== row.cardIdentityId) badKeys.add(sourceKey);
    else owners.set(sourceKey, row.cardIdentityId);
  }
  const candidates = raw.filter((row) => !badKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  counts.batchConflictKeys = badKeys.size;
  counts.batchHeldCandidates = raw.length - candidates.length;
  counts.safeExactMappings = candidates.length;
  if (counts.batchHeldCandidates) reason('batch_source_collision');

  const byVariant = {};
  for (const row of candidates) byVariant[row.variantCode] = (byVariant[row.variantCode] || 0) + 1;

  return {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
    },
    policy: {
      rootIdAloneNeverProvesFinish: true,
      exactBaselineFinishRequired: true,
      reverseExcluded: true,
      stampedAndSpecialFoilVariantsExcluded: true,
      meaningfulTargetPriceLaneRequired: true,
      ownershipFailClosed: true,
    },
    counts,
    reasons,
    byVariant,
    candidates,
  };
}

async function persist(db, report) {
  await db.query('BEGIN');
  try {
    for (const row of report.candidates) {
      const target = await db.query(`
        SELECT id FROM fatedrop_card_identities
        WHERE id=$1 AND verification_status='verified' AND language_code='en' AND variant_code=$2
        FOR UPDATE`, [row.cardIdentityId, row.variantCode]);
      if (target.rowCount !== 1) throw new Error(`Target identity changed: ${row.cardIdentityId}`);

      const existingIdentity = await db.query(`
        SELECT source_record_id, source_variant_key
        FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND card_identity_id=$1
        FOR UPDATE`, [row.cardIdentityId]);
      if (existingIdentity.rowCount !== 0) throw new Error(`Cardmarket identity ownership changed: ${row.cardIdentityId}`);

      const source = await db.query(`
        SELECT card_identity_id
        FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2
        FOR UPDATE`, [row.sourceRecordId, row.sourceVariantKey]);
      if (source.rowCount !== 0) throw new Error(`Cardmarket source ownership changed: ${row.sourceRecordId}/${row.sourceVariantKey}`);

      const now = Date.now();
      await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)`,
      [row.id, row.cardIdentityId, row.sourceRecordId, row.sourceVariantKey, row.sourceVersion, now]);
    }
    await db.query('COMMIT');
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
    report = await build(db);
    if (process.env.MAPPING_WRITE === 'true') {
      await persist(db, report);
      report = { ...report, status: 'write_complete', productionWrites: true };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-tcgdex-root-product-recovery-v2.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, counts: report.counts, reasons: report.reasons, byVariant: report.byVariant, samples: report.candidates?.slice(0, 20) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
