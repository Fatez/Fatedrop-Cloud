import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import {
  assessBaselineFinishEvidence,
  getRootCardmarketProductId,
  rootProductNameMatches,
} from './cardmarket-tcgdex-root-evidence.mjs';
import { hasSupportedCentralCardmarketLane } from './cardmarket-approved-residual-recovery-cli.mjs';

const REVIEWED_28_PATH = new URL('../../../evidence/reviewed-residual-28-rehearsal.json', import.meta.url);
const POLICY = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});
const key = (...parts) => parts.map((part) => String(part ?? '')).join('|');

function collector(value) {
  try { return normaliseCollectorNumber(String(value ?? '')); } catch { return null; }
}

function stableId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
}

function manifestDigest(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function reviewed28Ids() {
  const frozen = JSON.parse(await readFile(REVIEWED_28_PATH, 'utf8'));
  if (!Array.isArray(frozen?.candidates) || frozen.candidates.length !== 28) throw new Error('Reviewed residual 28 evidence drift');
  return new Set(frozen.candidates.map((row) => String(row.cardIdentityId)));
}

export async function build(db, { sources, repoEvidence } = {}) {
  const excluded28 = await reviewed28Ids();
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  const setByCardId = new Map();
  for (const set of repo.sets) for (const card of set.cards) {
    cardById.set(card.tcgdexCardId, card);
    setByCardId.set(card.tcgdexCardId, set);
  }

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,s.name AS set_name,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND s.name <> 'DP Black Star Promos'
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM fatedrop_market_observations o WHERE o.source_name='cardmarket' AND o.card_identity_id=i.id
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0)
    ORDER BY i.id`);

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of existing) {
    const sourceKey = key(row.source_record_id, row.source_variant_key);
    const prior = owners.get(sourceKey) || new Set();
    prior.add(row.card_identity_id);
    owners.set(sourceKey, prior);
  }

  const reasons = {};
  const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };
  const raw = [];
  const resolutions = [];
  let excludedReviewed28 = 0;

  for (const row of rows) {
    if (excluded28.has(String(row.id))) {
      excludedReviewed28 += 1;
      continue;
    }
    const policy = POLICY[row.variant_code];
    if (!policy) { bump('HOLD_UNSUPPORTED_FINISH'); continue; }
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      bump('HOLD_TCGDEX_LINK_COUNT'); resolutions.push({ cardIdentityId: row.id, status: 'HOLD_TCGDEX_LINK_COUNT' }); continue;
    }
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    const set = setByCardId.get(tcgdexCardId);
    if (!card || !set) { bump('HOLD_TCGDEX_EVIDENCE_MISSING'); resolutions.push({ cardIdentityId: row.id, status: 'HOLD_TCGDEX_EVIDENCE_MISSING' }); continue; }
    if (!rootProductNameMatches(row.name, card.name)) { bump('HOLD_TCGDEX_NAME_MISMATCH'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, status: 'HOLD_TCGDEX_NAME_MISMATCH' }); continue; }
    if (collector(row.collector_number) !== collector(card.localId)) { bump('HOLD_TCGDEX_COLLECTOR_MISMATCH'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, status: 'HOLD_TCGDEX_COLLECTOR_MISMATCH' }); continue; }

    const rootProductId = getRootCardmarketProductId(card);
    if (!rootProductId) { bump('HOLD_NO_ROOT_CARDMARKET_PRODUCT'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, status: 'HOLD_NO_ROOT_CARDMARKET_PRODUCT' }); continue; }
    const expansionId = Number(set.cardmarketExpansionId);
    if (!Number.isSafeInteger(expansionId) || expansionId <= 0) { bump('HOLD_SET_SCOPE_MISSING'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, status: 'HOLD_SET_SCOPE_MISSING' }); continue; }
    const product = productById.get(String(rootProductId));
    if (!product) { bump('HOLD_PRODUCT_MISSING_FROM_OFFICIAL_CATALOGUE'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, status: 'HOLD_PRODUCT_MISSING_FROM_OFFICIAL_CATALOGUE' }); continue; }
    if (Number(product.sourceExpansionId) !== expansionId) { bump('HOLD_EXPANSION_MISMATCH'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, status: 'HOLD_EXPANSION_MISMATCH' }); continue; }
    if (!rootProductNameMatches(row.name, product.name)) { bump('HOLD_PRODUCT_NAME_MISMATCH'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, status: 'HOLD_PRODUCT_NAME_MISMATCH' }); continue; }

    const finish = assessBaselineFinishEvidence(card, row.variant_code, rootProductId);
    if (!finish.ok) {
      const reason = `HOLD_FINISH_${String(finish.reason || 'UNPROVEN').toUpperCase()}`;
      bump(reason); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, sourceRecordId: String(rootProductId), status: reason, finish }); continue;
    }
    const priceRow = priceById.get(String(rootProductId));
    if (!hasSupportedCentralCardmarketLane(priceRow, policy.priceLane)) {
      bump('HOLD_NO_SUPPORTED_CENTRAL_TARGET_LANE'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, sourceRecordId: String(rootProductId), status: 'HOLD_NO_SUPPORTED_CENTRAL_TARGET_LANE' }); continue;
    }
    const sourceKey = key(rootProductId, policy.sourceVariantKey);
    const sourceOwners = owners.get(sourceKey);
    if (sourceOwners?.size && !(sourceOwners.size === 1 && sourceOwners.has(row.id))) {
      bump('HOLD_PRODUCT_ALREADY_OWNED'); resolutions.push({ cardIdentityId: row.id, tcgdexCardId, sourceRecordId: String(rootProductId), status: 'HOLD_PRODUCT_ALREADY_OWNED' }); continue;
    }

    raw.push(Object.freeze({
      id: stableId('fdcardmap', [row.id, 'cardmarket', String(rootProductId), policy.sourceVariantKey]),
      cardIdentityId: row.id,
      setName: row.set_name,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
      tcgdexCardId,
      sourceRecordId: String(rootProductId),
      sourceVariantKey: policy.sourceVariantKey,
      sourceVersion: catalogue.sha256,
      sourceExpansionId: expansionId,
      cardmarketProductName: product.name,
      priceLane: policy.priceLane,
      proof: Object.freeze({
        method: 'pinned_tcgdex_root_product_plus_explicit_baseline_target_finish',
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        tcgdexSetId: set.tcgdexSetId,
        tcgdexCardSourcePath: card.sourcePath,
        baselineTargetVariantCount: finish.baselineCount,
        explicitBaselineProductIds: finish.explicitProductIds,
        finishProofSource: 'pinned_tcgdex_baseline_variant',
      }),
    }));
    resolutions.push({ cardIdentityId: row.id, tcgdexCardId, sourceRecordId: String(rootProductId), status: 'PRE_BATCH_SAFE' });
  }

  const batchOwners = new Map();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId,row.sourceVariantKey);
    const ids = batchOwners.get(sourceKey) || new Set();
    ids.add(row.cardIdentityId);
    batchOwners.set(sourceKey, ids);
  }
  const collisionKeys = new Set([...batchOwners.entries()].filter(([, ids]) => ids.size > 1).map(([sourceKey]) => sourceKey));
  const candidates = raw.filter((row) => !collisionKeys.has(key(row.sourceRecordId,row.sourceVariantKey)));
  if (raw.length !== candidates.length) reasons.HOLD_BATCH_SOURCE_COLLISION = raw.length - candidates.length;

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({
      tcgdexRevision: process.env.TCGDEX_REVISION || null,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    policy: Object.freeze({
      reviewedResidual28Excluded: true,
      dpBlackStarPromosExcludedForSeparateReviewedBundle: true,
      rootProductMustBeExplicitInPinnedTcgdexCard: true,
      setScopeMustBeExplicitInPinnedTcgdexSet: true,
      exactBaselineTargetFinishMustBeExplicitInPinnedTcgdex: true,
      exactSupportedCentralTargetPriceLaneRequired: true,
      ownershipFailClosed: true,
      batchCollisionsFailClosed: true,
      approvedPriceAcquisition: 'cardmarket-public-download',
      productionWrites: false,
    }),
    counts: Object.freeze({
      currentNonDpResidualBeforeReviewed28Exclusion: rows.length,
      excludedReviewed28,
      audited: rows.length - excludedReviewed28,
      preBatchSafe: raw.length,
      safeExactMappings: candidates.length,
      held: rows.length - excludedReviewed28 - candidates.length,
      batchCollisionKeys: collisionKeys.size,
    }),
    candidateDigest: manifestDigest(candidates),
    reasons: Object.freeze(reasons),
    candidates: Object.freeze(candidates),
    resolutions: Object.freeze(resolutions),
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
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
  }
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-baseline-root-finish-audit.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, reasons: report.reasons, candidateDigest: report.candidateDigest, error: report.error }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
