import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const EVIDENCE_PATH = path.resolve('evidence/cardmarket-user-url-residual-audit-2026-09-14.json');
const POLICY = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});
const key = (...parts) => parts.map((part) => String(part ?? '')).join('|');
const stableId = (prefix, parts) => `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function collector(value) {
  try { return normaliseCollectorNumber(value); } catch { return null; }
}

function centralSupportedPrice(row, lane) {
  if (!row) return false;
  const fields = lane === 'standard'
    ? ['trend', 'avg1', 'avg7', 'avg30']
    : ['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo'];
  return fields.some((field) => Number(row[field] || 0) > 0);
}

function candidateDigest(rows) {
  return sha256([...rows]
    .map((row) => key(row.cardIdentityId, row.sourceRecordId, row.sourceVariantKey))
    .sort()
    .join('\n'));
}

async function loadEvidence() {
  const parsed = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));
  if (parsed?.schemaVersion !== 1) throw new Error('Unsupported URL evidence schema');
  if (parsed?.policy?.priceProvider !== 'cardmarket-public-download') throw new Error('URL evidence provider policy mismatch');
  if (parsed?.policy?.productionWrites !== false) throw new Error('Reviewed URL evidence must be read-only');
  return parsed;
}

export async function build(db, { repoEvidence, sources, evidence } = {}) {
  const reviewed = evidence || await loadEvidence();
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  if (repo.repositoryRoot == null) throw new Error('Pinned TCGdex repository evidence is required');

  const cardById = new Map();
  for (const set of repo.sets) for (const card of set.cards) cardById.set(card.tcgdexCardId, card);

  const [{ artifact: catalogueArtifact, products }, { artifact: guideArtifact, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  if (String(process.env.TCGDEX_REVISION || '') !== reviewed.tcgdexRevision) throw new Error('Pinned TCGdex revision mismatch');
  if (catalogueArtifact.sha256 !== reviewed.cardmarketCatalogueSha256) throw new Error('Cardmarket catalogue snapshot drift');
  if (guideArtifact.sha256 !== reviewed.cardmarketPriceGuideSha256) throw new Error('Cardmarket price-guide snapshot drift');
  if (snapshot.sourceSnapshotId !== reviewed.sourceSnapshotId) throw new Error('Cardmarket price-guide source snapshot mismatch');

  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));

  const { rows: identities } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,rs.classifier_state,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_market_observations o
        WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
          AND greatest(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0
      )
    ORDER BY i.id`);

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of existing) {
    const sourceKey = key(row.source_record_id, row.source_variant_key);
    const prior = owners.get(sourceKey);
    owners.set(sourceKey, prior && prior !== row.card_identity_id ? '__CONFLICT__' : row.card_identity_id);
  }

  const reasons = {};
  const raw = [];
  const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };

  for (const row of identities) {
    const policy = POLICY[row.variant_code];
    if (!policy) { bump('UNSUPPORTED_FINISH'); continue; }
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) { bump('TCGDEX_LINK_COUNT'); continue; }
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    if (!card) { bump('TCGDEX_CARD_EVIDENCE_MISSING'); continue; }
    if (!rootProductNameMatches(row.name, card.name)) { bump('TCGDEX_NAME_MISMATCH'); continue; }
    if (collector(row.collector_number) !== collector(card.localId)) { bump('TCGDEX_COLLECTOR_MISMATCH'); continue; }

    const targetIds = [...new Set((card.variants || [])
      .filter((variant) => variant?.type === policy.tcgdexType)
      .map((variant) => Number(variant?.cardmarketProductId))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .map(String))];
    if (targetIds.length === 0) { bump('NO_EXPLICIT_TARGET_FINISH_PRODUCT_ID'); continue; }
    if (targetIds.length !== 1) { bump('MULTIPLE_EXPLICIT_TARGET_FINISH_PRODUCT_IDS'); continue; }

    const sourceRecordId = targetIds[0];
    const product = productById.get(sourceRecordId);
    if (!product) { bump('PRODUCT_MISSING_OFFICIAL_CATALOGUE'); continue; }
    if (!rootProductNameMatches(row.name, product.name)) { bump('PRODUCT_NAME_MISMATCH'); continue; }

    const sourceOwner = owners.get(key(sourceRecordId, policy.sourceVariantKey));
    if (sourceOwner && sourceOwner !== row.id) { bump('SOURCE_OWNED_BY_OTHER_IDENTITY'); continue; }

    raw.push(Object.freeze({
      id: stableId('fdcardmap', [row.id, 'cardmarket', sourceRecordId, policy.sourceVariantKey]),
      cardIdentityId: row.id,
      variantCode: row.variant_code,
      name: row.name,
      collectorNumber: row.collector_number,
      tcgdexCardId,
      sourceRecordId,
      sourceVariantKey: policy.sourceVariantKey,
      priceLane: policy.priceLane,
      sourceVersion: catalogueArtifact.sha256,
      sourceExpansionId: product.sourceExpansionId ?? null,
      cardmarketProductName: product.name,
      currentSupportedCentralPrice: centralSupportedPrice(priceById.get(sourceRecordId), policy.priceLane),
      proof: Object.freeze({
        method: 'reviewed_user_cardmarket_url_plus_pinned_tcgdex_exact_target_finish_product_id',
        userUrlEvidenceFileSha256: reviewed.sourceFileSha256,
        reviewedCandidateDigest: reviewed.review.candidateDigest,
        tcgdexRevision: reviewed.tcgdexRevision,
      }),
    }));
  }

  const batchOwners = new Map();
  const collisionKeys = new Set();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId, row.sourceVariantKey);
    const prior = batchOwners.get(sourceKey);
    if (prior && prior !== row.cardIdentityId) collisionKeys.add(sourceKey);
    else batchOwners.set(sourceKey, row.cardIdentityId);
  }
  const candidates = raw.filter((row) => !collisionKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  if (raw.length !== candidates.length) reasons.BATCH_SOURCE_COLLISION = raw.length - candidates.length;
  const priceable = candidates.filter((row) => row.currentSupportedCentralPrice);

  const report = {
    status: 'audit_complete',
    productionWrites: false,
    source: {
      userUrlEvidenceFileSha256: reviewed.sourceFileSha256,
      tcgdexRevision: reviewed.tcgdexRevision,
      cardmarketCatalogueSha256: catalogueArtifact.sha256,
      cardmarketPriceGuideSha256: guideArtifact.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    },
    counts: {
      sectionB: identities.length,
      preBatchSafe: raw.length,
      safeExactMappings: candidates.length,
      currentlyCentralPriceable: priceable.length,
      held: identities.length - candidates.length,
      batchCollisionKeys: collisionKeys.size,
    },
    reasons,
    candidateDigest: candidateDigest(candidates),
    priceableCandidateDigest: candidateDigest(priceable),
    candidates,
  };

  const expected = reviewed.expected || reviewed.productionBaseline || {};
  if (report.counts.sectionB !== Number(expected.sectionB)) throw new Error(`Section B drift: expected ${expected.sectionB}, found ${report.counts.sectionB}`);
  if (report.counts.safeExactMappings !== Number(reviewed.review.sectionBSafeExactMappings)) throw new Error('Safe candidate count drift');
  if (report.counts.currentlyCentralPriceable !== Number(reviewed.review.sectionBCurrentlyCentralPriceable)) throw new Error('Priceable candidate count drift');
  if (report.candidateDigest !== reviewed.review.candidateDigest) throw new Error('Safe candidate digest drift');
  if (report.priceableCandidateDigest !== reviewed.review.priceableCandidateDigest) throw new Error('Priceable candidate digest drift');
  return report;
}

export async function persist(db, report) {
  if (report?.status !== 'audit_complete' || report?.productionWrites !== false) throw new Error('Reviewed read-only report required');
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-user-url-cardmarket-residual-recovery'))`);
    let insertedMappings = 0;
    for (const row of report.candidates) {
      const { rows: identityRows } = await db.query(`
        SELECT id,variant_code,language_code,verification_status
        FROM fatedrop_card_identities WHERE id=$1 FOR UPDATE`, [row.cardIdentityId]);
      const identity = identityRows[0];
      if (!identity || identity.verification_status !== 'verified' || identity.language_code !== 'en' || identity.variant_code !== row.variantCode) {
        throw new Error(`Canonical identity changed: ${row.cardIdentityId}`);
      }
      const { rows: stateRows } = await db.query(`
        SELECT classifier_state FROM fatedrop_variant_resolution_state WHERE card_identity_id=$1`, [row.cardIdentityId]);
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(stateRows[0]?.classifier_state)) {
        throw new Error(`Resolution state changed: ${row.cardIdentityId}`);
      }
      const canonical = await db.query(`
        SELECT source_record_id FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`, [row.cardIdentityId]);
      if (canonical.rowCount) throw new Error(`Identity already mapped: ${row.cardIdentityId}`);
      const source = await db.query(`
        SELECT card_identity_id FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`,
        [row.sourceRecordId, row.sourceVariantKey]);
      if (source.rowCount) throw new Error(`Source key already owned: ${row.sourceRecordId}/${row.sourceVariantKey}`);
      const now = Date.now();
      const inserted = await db.query(`
        INSERT INTO fatedrop_card_source_mappings(
          id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
        ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6)
        RETURNING id`, [row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceVersion,now]);
      insertedMappings += inserted.rowCount;
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
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = await pool.connect();
  let report;
  try {
    report = await build(db);
    if (process.env.MAPPING_WRITE === 'true') {
      const persistence = await persist(db, report);
      report = { ...report, status: 'write_complete', productionWrites: true, persistence };
    }
  } catch (error) {
    report = { status: 'blocked', productionWrites: false, error: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
  const output = `${process.env.RUNNER_TEMP || '.'}/cardmarket-user-url-residual-recovery.json`;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, productionWrites: report.productionWrites, counts: report.counts, reasons: report.reasons, candidateDigest: report.candidateDigest, priceableCandidateDigest: report.priceableCandidateDigest, persistence: report.persistence }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
