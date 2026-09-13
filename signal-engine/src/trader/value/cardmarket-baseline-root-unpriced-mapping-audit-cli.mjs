import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import {
  assessBaselineFinishEvidence,
  getRootCardmarketProductId,
  rootProductNameMatches,
} from './cardmarket-tcgdex-root-evidence.mjs';
import { build as buildPricedBaselineAudit } from './cardmarket-baseline-root-finish-audit-cli.mjs';

const POLICY = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});
const key = (...parts) => parts.map((part) => String(part ?? '')).join('|');

function collector(value) {
  try { return normaliseCollectorNumber(String(value ?? '')); } catch { return null; }
}

function stableId(cardIdentityId, sourceRecordId, sourceVariantKey) {
  const hash = createHash('sha256').update(`${cardIdentityId}|cardmarket|${sourceRecordId}|${sourceVariantKey}`).digest('hex').slice(0, 24);
  return `fdcardmap_${hash}`;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function build(db) {
  const pricedAudit = await buildPricedBaselineAudit(db);
  if (pricedAudit.status !== 'audit_complete') throw new Error('Baseline root audit did not complete');
  const targetResolutions = pricedAudit.resolutions.filter((row) => row.status === 'HOLD_NO_SUPPORTED_CENTRAL_TARGET_LANE');
  const targetIds = [...new Set(targetResolutions.map((row) => String(row.cardIdentityId)))];
  if (targetIds.length !== 68) throw new Error(`Baseline no-central-lane cohort drift: expected 68, found ${targetIds.length}`);

  const repo = loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  const setByCardId = new Map();
  for (const set of repo.sets) for (const card of set.cards) {
    cardById.set(card.tcgdexCardId, card);
    setByCardId.set(card.tcgdexCardId, set);
  }

  const { artifact: catalogue, products } = await fetchCardmarketPokemonSinglesCatalogue();
  if (catalogue.sha256 !== pricedAudit.source.cardmarketCatalogueSha256) throw new Error('Cardmarket catalogue SHA drift inside audit');
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,s.name AS set_name,
      COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') AS classifier_state,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.id = ANY($1::text[])
    ORDER BY i.id`, [targetIds]);
  const identityById = new Map(identities.map((row) => [String(row.id), row]));

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of existing) {
    const sourceKey = key(row.source_record_id,row.source_variant_key);
    const set = owners.get(sourceKey) || new Set();
    set.add(String(row.card_identity_id));
    owners.set(sourceKey,set);
  }

  const reasons = {};
  const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };
  const raw = [];
  const resolutions = [];

  for (const prior of targetResolutions) {
    const row = identityById.get(String(prior.cardIdentityId));
    if (!row || row.verification_status !== 'verified' || row.language_code !== 'en' || !POLICY[row.variant_code]) {
      bump('HOLD_CANONICAL_IDENTITY_DRIFT'); resolutions.push({ cardIdentityId: prior.cardIdentityId, status: 'HOLD_CANONICAL_IDENTITY_DRIFT' }); continue;
    }
    if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(row.classifier_state)) {
      bump('HOLD_RESOLUTION_STATE'); resolutions.push({ cardIdentityId: row.id, status: 'HOLD_RESOLUTION_STATE' }); continue;
    }
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1 || row.tcgdex_card_ids[0] !== prior.tcgdexCardId) {
      bump('HOLD_TCGDEX_LINK_DRIFT'); resolutions.push({ cardIdentityId: row.id, status: 'HOLD_TCGDEX_LINK_DRIFT' }); continue;
    }
    const card = cardById.get(prior.tcgdexCardId);
    const set = setByCardId.get(prior.tcgdexCardId);
    if (!card || !set) { bump('HOLD_TCGDEX_EVIDENCE_MISSING'); continue; }
    if (!rootProductNameMatches(row.name, card.name) || collector(row.collector_number) !== collector(card.localId)) {
      bump('HOLD_TCGDEX_IDENTITY_MISMATCH'); continue;
    }
    const rootProductId = getRootCardmarketProductId(card);
    if (String(rootProductId || '') !== String(prior.sourceRecordId)) { bump('HOLD_ROOT_PRODUCT_DRIFT'); continue; }
    const expansionId = Number(set.cardmarketExpansionId);
    const product = productById.get(String(rootProductId));
    if (!product || Number(product.sourceExpansionId) !== expansionId || !rootProductNameMatches(row.name, product.name)) {
      bump('HOLD_OFFICIAL_PRODUCT_SCOPE_DRIFT'); continue;
    }
    const finish = assessBaselineFinishEvidence(card, row.variant_code, rootProductId);
    if (!finish.ok) { bump('HOLD_EXACT_BASELINE_FINISH_UNPROVEN'); continue; }

    const policy = POLICY[row.variant_code];
    const sourceKey = key(rootProductId,policy.sourceVariantKey);
    const sourceOwners = owners.get(sourceKey);
    if (sourceOwners?.size && !(sourceOwners.size === 1 && sourceOwners.has(String(row.id)))) {
      bump('HOLD_PRODUCT_ALREADY_OWNED'); resolutions.push({ cardIdentityId: row.id, sourceRecordId: String(rootProductId), status: 'HOLD_PRODUCT_ALREADY_OWNED' }); continue;
    }

    raw.push(Object.freeze({
      id: stableId(String(row.id), String(rootProductId), policy.sourceVariantKey),
      cardIdentityId: String(row.id),
      setName: row.set_name,
      name: row.name,
      collectorNumber: row.collector_number,
      variantCode: row.variant_code,
      tcgdexCardId: prior.tcgdexCardId,
      sourceRecordId: String(rootProductId),
      sourceVariantKey: policy.sourceVariantKey,
      sourceVersion: catalogue.sha256,
      sourceExpansionId: expansionId,
      cardmarketProductName: product.name,
      priceLane: policy.priceLane,
      priceableNow: false,
      proof: Object.freeze({
        method: 'pinned_tcgdex_root_product_plus_explicit_baseline_target_finish_no_supported_central_price',
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        tcgdexSetId: set.tcgdexSetId,
        tcgdexCardSourcePath: card.sourcePath,
        baselineTargetVariantCount: finish.baselineCount,
        explicitBaselineProductIds: finish.explicitProductIds,
        finishProofSource: 'pinned_tcgdex_baseline_variant',
        numericPriceOutcome: 'ACTIVE_UNPRICED',
      }),
    }));
    resolutions.push({ cardIdentityId: row.id, sourceRecordId: String(rootProductId), status: 'SAFE_MAPPING_ACTIVE_UNPRICED' });
  }

  const batchOwners = new Map();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId,row.sourceVariantKey);
    const ids = batchOwners.get(sourceKey) || new Set();
    ids.add(row.cardIdentityId);
    batchOwners.set(sourceKey,ids);
  }
  const collisionKeys = new Set([...batchOwners.entries()].filter(([, ids]) => ids.size > 1).map(([sourceKey]) => sourceKey));
  const candidates = raw.filter((row) => !collisionKeys.has(key(row.sourceRecordId,row.sourceVariantKey)));
  if (raw.length !== candidates.length) reasons.HOLD_BATCH_SOURCE_COLLISION = raw.length - candidates.length;

  return Object.freeze({
    status: 'audit_complete',
    productionWrites: false,
    source: Object.freeze({ ...pricedAudit.source }),
    policy: Object.freeze({
      exactMappingMayBePersistedWithoutInventingNumericPrice: true,
      numericOutcomeForCandidates: 'ACTIVE_UNPRICED',
      approvedPriceAcquisition: 'cardmarket-public-download',
      exactPinnedTcgdexBaselineFinishRequired: true,
      rootProductAndExpansionMustRemainExact: true,
      ownershipFailClosed: true,
      batchCollisionsFailClosed: true,
      productionWrites: false,
    }),
    counts: Object.freeze({
      priorNoCentralLaneHolds: targetResolutions.length,
      preBatchSafeMappings: raw.length,
      safeExactMappingsActiveUnpriced: candidates.length,
      heldAfterOwnershipAndReplayChecks: targetResolutions.length - candidates.length,
      batchCollisionKeys: collisionKeys.size,
    }),
    candidateDigest: digest(candidates),
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
  await writeFile(`${process.env.RUNNER_TEMP || '.'}/cardmarket-baseline-root-unpriced-mapping-audit.json`, JSON.stringify(report,null,2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, source: report.source, counts: report.counts, reasons: report.reasons, candidateDigest: report.candidateDigest, error: report.error }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
