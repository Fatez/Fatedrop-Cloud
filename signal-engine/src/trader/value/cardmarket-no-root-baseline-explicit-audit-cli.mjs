import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { ROOT_FINISH_POLICY, getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const key = (...parts) => parts.join('|');

function baselineVariants(card, variantCode) {
  const policy = ROOT_FINISH_POLICY[variantCode];
  if (!policy) return [];
  return (card?.variants || []).filter((variant) =>
    variant?.type === policy.tcgdexType
    && !variant?.subtype
    && !variant?.foil
    && Array.isArray(variant?.stamp)
    && variant.stamp.length === 0);
}

async function build(db) {
  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
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
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const sourceOwners = new Map(existing.map((row) => [key(row.source_record_id, row.source_variant_key), row.card_identity_id]));

  const counts = {
    eligible: identities.length,
    singleTcgdexLink: 0,
    noRootProductId: 0,
    withBaselineTargetVariant: 0,
    withOneExplicitBaselineProductId: 0,
    productExists: 0,
    nameCompatible: 0,
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
    if (getRootCardmarketProductId(card)) { reason('root_product_id_present'); continue; }
    counts.noRootProductId += 1;

    const baseline = baselineVariants(card, identity.variant_code);
    if (baseline.length === 0) { reason('no_baseline_target_variant'); continue; }
    counts.withBaselineTargetVariant += 1;

    const explicitProductIds = [...new Set(
      baseline.map((variant) => Number(variant.cardmarketProductId))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    )];
    if (explicitProductIds.length === 0) { reason('baseline_target_variant_has_no_explicit_product_id'); continue; }
    if (explicitProductIds.length !== 1) { reason('multiple_explicit_product_ids_for_baseline_finish'); continue; }
    counts.withOneExplicitBaselineProductId += 1;

    const sourceRecordId = String(explicitProductIds[0]);
    const product = productById.get(sourceRecordId);
    if (!product) { reason('explicit_product_absent_from_official_catalogue'); continue; }
    counts.productExists += 1;
    if (!rootProductNameMatches(identity.name, product.name)) { reason('explicit_product_name_conflict'); continue; }
    counts.nameCompatible += 1;

    const policy = ROOT_FINISH_POLICY[identity.variant_code];
    const priceRow = priceById.get(sourceRecordId);
    if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, policy.priceLane)) {
      reason('no_meaningful_target_price_lane');
      continue;
    }
    counts.priceable += 1;

    const sourceKey = key(sourceRecordId, policy.sourceVariantKey);
    const owner = sourceOwners.get(sourceKey);
    if (owner && owner !== identity.id) { reason('source_owned'); continue; }

    raw.push({
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
        method: 'pinned_tcgdex_explicit_baseline_finish_product_id_without_root_id',
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        baselineCount: baseline.length,
        explicitProductId: explicitProductIds[0],
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
      rootProductMustBeAbsent: true,
      exactBaselineTargetFinishRequired: true,
      exactlyOneExplicitBaselineProductIdRequired: true,
      exactProviderNameCompatibilityRequired: true,
      meaningfulTargetFinishPriceLaneRequired: true,
      reverseStampedAndSpecialFoilsExcluded: true,
      ownershipFailClosed: true,
      batchCollisionsFailClosed: true,
    },
    counts,
    reasons,
    byVariant,
    candidates,
  };
}

async function main() {
  if (process.env.MAPPING_WRITE === 'true') throw new Error('This audit is read-only');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-no-root-baseline-explicit-audit.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, counts: report.counts, reasons: report.reasons, byVariant: report.byVariant, samples: report.candidates?.slice(0, 30) }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
