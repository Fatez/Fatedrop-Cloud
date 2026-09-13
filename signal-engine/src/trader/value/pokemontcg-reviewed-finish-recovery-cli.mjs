import { REVIEWED_STALE_VARIANT_RETIREMENTS } from './cardmarket-reviewed-stale-variant-retirement.mjs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { loadReviewedCombinedCardmarketRecovery } from './pokemontcg-reviewed-finish-recovery.mjs';

const QUARANTINED_TCGDEX_SET_IDS = new Set(['base2', 'base3', 'base5', 'gym1', 'neo1', 'neo2', 'neo3', 'neo4']);
const key = (...parts) => parts.join('|');

export function isPreviouslyRetiredMapping(row) {
  return REVIEWED_STALE_VARIANT_RETIREMENTS.some(retired =>
    retired.mappingId === row.id || (
      retired.cardIdentityId === row.cardIdentityId
      && retired.sourceRecordId === String(row.sourceRecordId)
      && retired.sourceVariantKey === row.sourceVariantKey
    ));
}

export function normaliseReviewedCollectorNumber(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/(^|[^0-9])0+(?=\d)/g, '$1');
}

function groupBy(rows, field) {
  const out = {};
  for (const row of rows) out[row[field]] = (out[row[field]] || 0) + 1;
  return out;
}

export async function buildReviewedFinishRecovery(db, { sources } = {}) {
  const frozen = loadReviewedCombinedCardmarketRecovery();
  const candidates = frozen.candidates;
  const identityIds = candidates.map((row) => row.cardIdentityId);
  const productIds = [...new Set(candidates.map((row) => String(row.sourceRecordId)))];

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id,i.variant_code,i.language_code,i.verification_status,i.set_id,p.name,p.collector_number
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.id=ANY($1::text[])`, [identityIds]);
  const identityById = new Map(identities.map((row) => [row.id, row]));

  const { rows: tcgdexRows } = await db.query(`
    SELECT card_identity_id,source_record_id
    FROM fatedrop_card_source_mappings
    WHERE source_name='tcgdex' AND card_identity_id=ANY($1::text[])`, [identityIds]);
  const tcgdexByIdentity = new Map();
  for (const row of tcgdexRows) {
    if (!tcgdexByIdentity.has(row.card_identity_id)) tcgdexByIdentity.set(row.card_identity_id, new Set());
    tcgdexByIdentity.get(row.card_identity_id).add(String(row.source_record_id));
  }

  const setIds = [...new Set(identities.map((row) => row.set_id))];
  const { rows: setMappings } = await db.query(`
    SELECT set_id,source_record_id
    FROM fatedrop_card_set_source_mappings
    WHERE source_name='tcgdex' AND set_id=ANY($1::text[])`, [setIds]);
  const tcgdexSetsBySetId = new Map();
  for (const row of setMappings) {
    if (!tcgdexSetsBySetId.has(row.set_id)) tcgdexSetsBySetId.set(row.set_id, new Set());
    tcgdexSetsBySetId.get(row.set_id).add(String(row.source_record_id));
  }

  const { rows: currentMappings } = await db.query(`
    SELECT id,card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'
      AND (source_record_id=ANY($1::text[]) OR card_identity_id=ANY($2::text[]))`, [productIds, identityIds]);
  const sourceOwners = new Map();
  const identityVariantOwners = new Map();
  const mappingById = new Map(currentMappings.map((row) => [row.id, row]));
  for (const row of currentMappings) {
    const sourceKey = key(String(row.source_record_id), row.source_variant_key);
    if (!sourceOwners.has(sourceKey)) sourceOwners.set(sourceKey, []);
    sourceOwners.get(sourceKey).push(row);
    const identityKey = key(row.card_identity_id, row.source_variant_key);
    if (!identityVariantOwners.has(identityKey)) identityVariantOwners.set(identityKey, []);
    identityVariantOwners.get(identityKey).push(row);
  }

  const safeNew = [];
  const alreadyApplied = [];
  const blocked = [];
  const block = (row, reason, detail = {}) => blocked.push({ cardIdentityId: row.cardIdentityId, tcgdexCardId: row.tcgdexCardId, sourceRecordId: String(row.sourceRecordId), sourceVariantKey: row.sourceVariantKey, reason, ...detail });

  for (const row of candidates) {
    if (isPreviouslyRetiredMapping(row)) { block(row, 'previously_retired_mapping_requires_new_review'); continue; }
    const identity = identityById.get(row.cardIdentityId);
    if (!identity) { block(row, 'canonical_identity_missing'); continue; }
    if (identity.verification_status !== 'verified' || identity.language_code !== 'en' || identity.variant_code !== row.variantCode) {
      block(row, 'canonical_identity_state_drift', { currentVariantCode: identity.variant_code, languageCode: identity.language_code, verificationStatus: identity.verification_status });
      continue;
    }
    if (normaliseReviewedCollectorNumber(identity.collector_number) !== normaliseReviewedCollectorNumber(row.collectorNumber)) {
      block(row, 'canonical_collector_number_drift', { frozenCollectorNumber: row.collectorNumber, currentCollectorNumber: identity.collector_number });
      continue;
    }
    if (!rootProductNameMatches(identity.name, row.name) || !rootProductNameMatches(row.name, identity.name)) {
      block(row, 'canonical_name_drift', { frozenName: row.name, currentName: identity.name });
      continue;
    }
    const tcgdexLinks = tcgdexByIdentity.get(row.cardIdentityId) || new Set();
    if (tcgdexLinks.size !== 1 || !tcgdexLinks.has(row.tcgdexCardId)) {
      block(row, 'tcgdex_identity_link_drift', { currentTcgdexCardIds: [...tcgdexLinks].sort() });
      continue;
    }
    const setLinks = tcgdexSetsBySetId.get(identity.set_id) || new Set();
    if ([...setLinks].some((setId) => QUARANTINED_TCGDEX_SET_IDS.has(setId))) {
      block(row, 'intentional_first_edition_quarantine', { tcgdexSetIds: [...setLinks].sort() });
      continue;
    }
    const product = productById.get(String(row.sourceRecordId));
    if (!product) { block(row, 'cardmarket_product_absent'); continue; }
    if (!rootProductNameMatches(identity.name, product.name)) {
      block(row, 'cardmarket_product_name_drift', { canonicalName: identity.name, providerName: product.name });
      continue;
    }
    const priceRow = priceById.get(String(row.sourceRecordId));
    if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, row.providerPriceGuideLane)) {
      block(row, 'cardmarket_price_lane_unavailable', { providerPriceGuideLane: row.providerPriceGuideLane });
      continue;
    }

    if (row.proof?.method === 'same_printing_single_exact_cardmarket_product_with_meaningful_target_finish_lane') {
      const siblings = Array.isArray(row.proof?.siblingEvidence) ? row.proof.siblingEvidence : [];
      const sibling = siblings.length === 1 ? siblings[0] : null;
      const siblingOwners = sourceOwners.get(key(String(row.sourceRecordId), 'holo')) || [];
      if (row.variantCode !== 'standard' || row.sourceVariantKey !== 'normal' || row.providerPriceGuideLane !== 'standard'
        || !sibling || sibling.variantCode !== 'holo' || sibling.sourceVariantKey !== 'holo'
        || !siblingOwners.some((existing) => existing.card_identity_id === sibling.cardIdentityId)) {
        block(row, 'sibling_finish_evidence_drift', { siblingOwners: siblingOwners.map((existing) => existing.card_identity_id).sort() });
        continue;
      }
    } else if (row.proof?.cardmarketLaneBasis === 'externally_proven_inherent_holo_base_lane') {
      const finishKeys = Array.isArray(row.proof?.externalFinishKeys) ? row.proof.externalFinishKeys : [];
      if (row.variantCode !== 'holo' || row.providerPriceGuideLane !== 'standard' || !finishKeys.includes('holofoil') || finishKeys.includes('normal') || hasMeaningfulCardmarketLane(priceRow, 'holo')) {
        block(row, 'inherent_holo_policy_drift');
        continue;
      }
    } else if (row.proof?.cardmarketLaneBasis !== 'direct_cardmarket_finish_lane') {
      block(row, 'unsupported_lane_basis');
      continue;
    }

    const sourceKey = key(String(row.sourceRecordId), row.sourceVariantKey);
    const sourceRows = sourceOwners.get(sourceKey) || [];
    if (sourceRows.some((existing) => existing.card_identity_id !== row.cardIdentityId)) {
      block(row, 'source_finish_owned_by_other_identity', { existingOwners: sourceRows.map((existing) => existing.card_identity_id).sort() });
      continue;
    }
    const identityKey = key(row.cardIdentityId, row.sourceVariantKey);
    const identityRows = identityVariantOwners.get(identityKey) || [];
    if (identityRows.some((existing) => String(existing.source_record_id) !== String(row.sourceRecordId))) {
      block(row, 'identity_finish_owned_by_other_product', { existingProducts: identityRows.map((existing) => String(existing.source_record_id)).sort() });
      continue;
    }
    const idRow = mappingById.get(row.id);
    if (idRow && (idRow.card_identity_id !== row.cardIdentityId || String(idRow.source_record_id) !== String(row.sourceRecordId) || idRow.source_variant_key !== row.sourceVariantKey)) {
      block(row, 'mapping_id_collision');
      continue;
    }
    const exactExisting = sourceRows.find((existing) => existing.card_identity_id === row.cardIdentityId)
      || identityRows.find((existing) => String(existing.source_record_id) === String(row.sourceRecordId));
    if (exactExisting) alreadyApplied.push(row);
    else safeNew.push(row);
  }

  const status = blocked.length ? 'blocked' : 'clean';
  return {
    status,
    productionWrites: false,
    activationAuthorized: false,
    frozenEvidence: {
      externalAuditRunId: 34719433407,
      siblingBundleRunId: 34717195189,
      candidateCount: candidates.length,
      externalEvidenceSha256: frozen.external.report.source?.pokemonTcg?.sha256,
    },
    excludedRetiredCandidates: frozen.excludedRetiredCandidates,
    excludedFinishCandidates: frozen.excludedFinishCandidates,
    currentSources: { cardmarketCatalogueSha256: catalogue.sha256, cardmarketPriceGuideSha256: guide.sha256 },
    counts: {
      reviewedCandidates: candidates.length,
      safeNewMappings: safeNew.length,
      alreadyAppliedMappings: alreadyApplied.length,
      blockedMappings: blocked.length,
      standard: candidates.filter((row) => row.variantCode === 'standard').length,
      holo: candidates.filter((row) => row.variantCode === 'holo').length,
      directLane: candidates.filter((row) => row.proof?.cardmarketLaneBasis === 'direct_cardmarket_finish_lane').length,
      inherentHoloBaseLane: candidates.filter((row) => row.proof?.cardmarketLaneBasis === 'externally_proven_inherent_holo_base_lane').length,
      siblingProven: candidates.filter((row) => row.proof?.method === 'same_printing_single_exact_cardmarket_product_with_meaningful_target_finish_lane').length,
    },
    blockedByReason: groupBy(blocked, 'reason'),
    safeNew,
    alreadyApplied,
    blocked,
  };
}

export async function persistReviewedFinishRecovery(db, report) {
  if (report.status !== 'clean' || report.blocked.length) throw new Error('Reviewed finish recovery is not clean');
  if (report.safeNew.some(isPreviouslyRetiredMapping)) throw new Error('Previously retired mapping cannot be restored by finish recovery');
  const expectedNew = process.env.EXPECTED_NEW_MAPPINGS === undefined ? null : Number(process.env.EXPECTED_NEW_MAPPINGS);
  if (expectedNew != null && report.safeNew.length !== expectedNew) throw new Error(`Expected ${expectedNew} new mappings, found ${report.safeNew.length}`);
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-cardmarket-reviewed-finish-recovery'))`);
    const observedAt = Date.now();
    for (const row of report.safeNew) {
      const sourceCheck = await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`, [String(row.sourceRecordId), row.sourceVariantKey]);
      if (sourceCheck.rows.some((existing) => existing.card_identity_id !== row.cardIdentityId)) throw new Error(`Cardmarket source ownership changed for ${row.sourceRecordId}|${row.sourceVariantKey}`);
      const identityCheck = await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2 FOR UPDATE`, [row.cardIdentityId, row.sourceVariantKey]);
      if (identityCheck.rows.some((existing) => String(existing.source_record_id) !== String(row.sourceRecordId))) throw new Error(`Canonical Cardmarket mapping changed for ${row.cardIdentityId}|${row.sourceVariantKey}`);
      await db.query(`INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at)
        VALUES ($1,$2,'cardmarket',$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING`, [row.id, row.cardIdentityId, String(row.sourceRecordId), row.sourceVariantKey, row.sourceVersion, observedAt]);
    }
    await db.query('COMMIT');
    return { saved: report.safeNew.length };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (process.env.PRICE_WRITE === 'true') throw new Error('Reviewed finish recovery never writes prices directly');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await buildReviewedFinishRecovery(db);
    if (report.status !== 'clean') process.exitCode = 1;
    const expectedReviewed = Number(process.env.EXPECTED_REVIEWED_MAPPINGS || 409);
    if (report.counts.reviewedCandidates !== expectedReviewed) throw new Error(`Expected ${expectedReviewed} reviewed mappings, found ${report.counts.reviewedCandidates}`);
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persistReviewedFinishRecovery(db, report);
      report = { ...report, productionWrites: true, activationAuthorized: true, persistence };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, activationAuthorized: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP || '.'}/pokemontcg-reviewed-finish-recovery.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, counts: report.counts, blockedByReason: report.blockedByReason, persistence: report.persistence }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
