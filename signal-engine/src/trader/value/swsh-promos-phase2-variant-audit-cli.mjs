import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasSupportedCentralCardmarketLane } from './cardmarket-approved-residual-recovery-cli.mjs';

const MANIFEST_PATH = new URL('../../../evidence/swsh-promos-phase2-held-ids-2026-09-14.json', import.meta.url);
const SET_NAME = 'SWSH Black Star Promos';
const TCGDEX_SET_ID = 'swshp';
const TCGDEX_REVISION = '5b6a2859f454972477a9953ffe5cb554d24c45e9';
const CARDMARKET_EXPANSION_ID = 2916;
const EXPECTED_HELD = 97;
const POLICY = Object.freeze({
  standard: Object.freeze({ tcgdexType: 'normal', sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ tcgdexType: 'holo', sourceVariantKey: 'holo', priceLane: 'holo' }),
});

const text = (value) => String(value ?? '').trim();
const key = (...parts) => parts.map((part) => text(part)).join('|');
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function collector(value) {
  try { return normaliseCollectorNumber(text(value)); } catch { return null; }
}

function isOrdinaryVariant(variant) {
  return !variant?.subtype && !variant?.foil && Array.isArray(variant?.stamp) && variant.stamp.length === 0;
}

function uniquePositiveProductIds(variants) {
  return [...new Set((variants || [])
    .map((variant) => Number(variant?.cardmarketProductId))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .map(String))];
}

function csvCell(value) {
  if (value == null) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

function toCsv(rows) {
  const columns = [
    'cardIdentityId','collectorNumber','name','variantCode','status','sourceRecordId','sourceVariantKey','priceLane',
    'existingCardmarketMappings','ordinaryExplicitProductIds','specialExplicitProductIds','standardLane','holoLane','mappingAction',
  ];
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

function stableMappingId(identityId, productId, sourceVariantKey) {
  return `fdcardmap_${createHash('sha256').update(`${identityId}|cardmarket|${productId}|${sourceVariantKey}`).digest('hex').slice(0, 24)}`;
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.setName !== SET_NAME || manifest.tcgdexSetId !== TCGDEX_SET_ID) {
    throw new Error('SWSH phase 2 manifest scope mismatch');
  }
  if (Number(manifest.cardmarketExpansionId) !== CARDMARKET_EXPANSION_ID) throw new Error('SWSH phase 2 expansion mismatch');
  if (Number(manifest.heldCount) !== EXPECTED_HELD || manifest.cardIdentityIds?.length !== EXPECTED_HELD) {
    throw new Error('SWSH phase 2 held cohort count drift');
  }
  if (new Set(manifest.cardIdentityIds).size !== EXPECTED_HELD) throw new Error('SWSH phase 2 manifest contains duplicate identities');
  return manifest;
}

export async function build(db, { repoEvidence, sources } = {}) {
  const manifest = await loadManifest();
  if (text(process.env.TCGDEX_REVISION) !== TCGDEX_REVISION) throw new Error('Pinned TCGdex revision mismatch');
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const set = repo.bySetId.get(TCGDEX_SET_ID);
  if (!set || set.setName !== SET_NAME) throw new Error('Pinned SWSH promo set missing or renamed');
  if (Number(set.cardmarketExpansionId) !== CARDMARKET_EXPANSION_ID) throw new Error('Pinned SWSH promo Cardmarket expansion drift');

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById = new Map(products.map((row) => [String(row.sourceRecordId), row]));
  const priceById = new Map(snapshot.priceGuides.map((row) => [String(row.idProduct), row]));
  const cards = new Map(set.cards.map((card) => [card.tcgdexCardId, card]));

  const { rows } = await db.query(`
    SELECT i.id,i.variant_code,p.name,p.collector_number,s.name AS set_name,
      EXISTS(SELECT 1 FROM fatedrop_market_observations o WHERE o.card_identity_id=i.id AND o.source_name='cardmarket'
        AND GREATEST(COALESCE(o.market_price,0),COALESCE(o.trend_price,0),COALESCE(o.avg_1d,0),COALESCE(o.avg_7d,0),COALESCE(o.avg_30d,0))>0) AS already_priced,
      ARRAY(SELECT DISTINCT t.source_record_id FROM fatedrop_card_source_mappings t
        WHERE t.card_identity_id=i.id AND t.source_name='tcgdex' ORDER BY t.source_record_id) AS tcgdex_card_ids,
      ARRAY(SELECT m.source_record_id || ':' || COALESCE(m.source_variant_key,'') FROM fatedrop_card_source_mappings m
        WHERE m.card_identity_id=i.id AND m.source_name='cardmarket' ORDER BY m.source_record_id,m.source_variant_key) AS cardmarket_mappings
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
    WHERE i.id=ANY($1::text[])
      AND i.verification_status='verified'
      AND i.language_code='en'
      AND COALESCE(rs.classifier_state,'ACTIVE_UNPRICED') NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE')
    ORDER BY p.collector_number,i.variant_code,i.id`, [manifest.cardIdentityIds]);
  if (rows.length !== EXPECTED_HELD) throw new Error(`SWSH phase 2 production cohort drift: expected ${EXPECTED_HELD}, found ${rows.length}`);

  const byIdentity = new Map(rows.map((row) => [row.id, row]));
  for (const identityId of manifest.cardIdentityIds) if (!byIdentity.has(identityId)) throw new Error(`Missing held identity ${identityId}`);

  const { rows: ownerRows } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const owner of ownerRows) {
    const ownerKey = key(owner.source_record_id, owner.source_variant_key);
    const ids = owners.get(ownerKey) || new Set();
    ids.add(owner.card_identity_id);
    owners.set(ownerKey, ids);
  }

  const outcomes = [];
  const reasons = {};
  const bump = (status) => { reasons[status] = (reasons[status] || 0) + 1; };

  for (const identityId of manifest.cardIdentityIds) {
    const row = byIdentity.get(identityId);
    const policy = POLICY[row.variant_code];
    const tcgdexIds = row.tcgdex_card_ids || [];
    const existingMappings = row.cardmarket_mappings || [];
    let status = null;
    let card = null;
    let sourceRecordId = null;
    let product = null;
    let ordinaryExplicitProductIds = [];
    let specialExplicitProductIds = [];
    let standardLane = false;
    let holoLane = false;
    let mappingAction = 'none';

    if (row.set_name !== SET_NAME) status = 'HOLD_SET_SCOPE_DRIFT';
    else if (!policy) status = 'HOLD_UNSUPPORTED_FINISH';
    else if (row.already_priced) status = 'SKIP_ALREADY_PRICE_RESOLVED';
    else if (tcgdexIds.length !== 1) status = 'HOLD_TCGDEX_LINK_COUNT';
    else {
      card = cards.get(tcgdexIds[0]);
      if (!card) status = 'HOLD_TCGDEX_CARD_MISSING';
      else if (!rootProductNameMatches(row.name, card.name)) status = 'HOLD_TCGDEX_NAME_MISMATCH';
      else if (collector(row.collector_number) !== collector(card.localId)) status = 'HOLD_TCGDEX_COLLECTOR_MISMATCH';
    }

    if (!status) {
      const exact = (card.variants || []).filter((variant) => variant?.type === policy.tcgdexType);
      const ordinary = exact.filter(isOrdinaryVariant);
      const special = exact.filter((variant) => !isOrdinaryVariant(variant));
      ordinaryExplicitProductIds = uniquePositiveProductIds(ordinary);
      specialExplicitProductIds = uniquePositiveProductIds(special);

      if (ordinaryExplicitProductIds.length === 0) status = 'HOLD_NO_EXPLICIT_ORDINARY_VARIANT_PRODUCT_ID';
      else if (ordinaryExplicitProductIds.length > 1) status = 'HOLD_MULTIPLE_ORDINARY_VARIANT_PRODUCT_IDS';
      else sourceRecordId = ordinaryExplicitProductIds[0];
    }

    if (!status && sourceRecordId) {
      product = productById.get(sourceRecordId) || null;
      if (!product) status = 'HOLD_EXPLICIT_PRODUCT_MISSING_FROM_CATALOGUE';
      else if (Number(product.sourceExpansionId) !== CARDMARKET_EXPANSION_ID) status = 'HOLD_EXPLICIT_PRODUCT_EXPANSION_MISMATCH';
      else if (!rootProductNameMatches(row.name, product.name)) status = 'HOLD_EXPLICIT_PRODUCT_NAME_MISMATCH';
    }

    if (!status && sourceRecordId) {
      if (existingMappings.length > 1) status = 'HOLD_MULTIPLE_EXISTING_CARDMARKET_MAPPINGS';
      else if (existingMappings.length === 1) {
        const expected = `${sourceRecordId}:${policy.sourceVariantKey}`;
        if (existingMappings[0] !== expected) status = 'HOLD_EXISTING_MAPPING_DISAGREES_WITH_EXPLICIT_VARIANT';
        else mappingAction = 'retain_existing_exact_mapping';
      } else {
        mappingAction = 'insert_exact_mapping';
      }
    }

    if (!status && sourceRecordId) {
      const sourceOwners = owners.get(key(sourceRecordId, policy.sourceVariantKey));
      if (sourceOwners?.size && !(sourceOwners.size === 1 && sourceOwners.has(identityId))) {
        status = 'HOLD_PRODUCT_ALREADY_OWNED';
      }
    }

    if (!status && sourceRecordId) {
      const priceRow = priceById.get(sourceRecordId);
      standardLane = hasSupportedCentralCardmarketLane(priceRow, 'standard');
      holoLane = hasSupportedCentralCardmarketLane(priceRow, 'holo');
      if (row.variant_code === 'standard') {
        status = standardLane ? 'READY_STANDARD_LANE' : 'RESOLVED_MAPPING_PRICE_UNAVAILABLE';
      } else if (holoLane) {
        status = 'READY_HOLO_LANE';
      } else if (standardLane) {
        status = 'REVIEW_BASE_LANE_ELIGIBLE';
      } else {
        status = 'RESOLVED_MAPPING_PRICE_UNAVAILABLE';
      }
    }

    bump(status);
    outcomes.push(Object.freeze({
      cardIdentityId: identityId,
      collectorNumber: row.collector_number,
      name: row.name,
      variantCode: row.variant_code,
      tcgdexCardId: tcgdexIds.length === 1 ? tcgdexIds[0] : null,
      status,
      sourceRecordId,
      sourceVariantKey: policy?.sourceVariantKey ?? null,
      priceLane: policy?.priceLane ?? null,
      cardmarketProductName: product?.name ?? null,
      existingCardmarketMappings: existingMappings,
      ordinaryExplicitProductIds,
      specialExplicitProductIds,
      standardLane,
      holoLane,
      mappingAction,
      proposedMappingId: sourceRecordId && policy ? stableMappingId(identityId, sourceRecordId, policy.sourceVariantKey) : null,
      ordinaryVariantProof: sourceRecordId ? 'pinned_tcgdex_unstamped_exact_finish_variant_explicit_cardmarket_id' : null,
    }));
  }

  const direct = outcomes.filter((row) => ['READY_STANDARD_LANE','READY_HOLO_LANE'].includes(row.status));
  const baseLaneReview = outcomes.filter((row) => row.status === 'REVIEW_BASE_LANE_ELIGIBLE');
  const resolvedUnpriced = outcomes.filter((row) => row.status === 'RESOLVED_MAPPING_PRICE_UNAVAILABLE');
  const mappingCandidates = outcomes.filter((row) => row.mappingAction === 'insert_exact_mapping' && ['READY_STANDARD_LANE','READY_HOLO_LANE','REVIEW_BASE_LANE_ELIGIBLE','RESOLVED_MAPPING_PRICE_UNAVAILABLE'].includes(row.status));
  const held = outcomes.filter((row) => row.status.startsWith('HOLD_'));
  const candidateDigest = sha256(mappingCandidates.map((row) => [row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.status]).sort());

  return Object.freeze({
    status: 'phase2_audit_complete',
    productionWrites: false,
    source: Object.freeze({
      sourceAuditRun: manifest.sourceAuditRun,
      sourceAuditArtifactId: manifest.sourceAuditArtifactId,
      sourceAuditCohortDigest: manifest.sourceAuditCohortDigest,
      tcgdexRevision: TCGDEX_REVISION,
      tcgdexSetId: TCGDEX_SET_ID,
      cardmarketExpansionId: CARDMARKET_EXPANSION_ID,
      cardmarketCatalogueSha256: catalogue.sha256,
      cardmarketPriceGuideSha256: guide.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId,
    }),
    counts: Object.freeze({
      heldInput: outcomes.length,
      mappingCandidates: mappingCandidates.length,
      directlyPriceable: direct.length,
      baseLaneReview: baseLaneReview.length,
      resolvedPriceUnavailable: resolvedUnpriced.length,
      held: held.length,
      alreadyPriceResolved: outcomes.filter((row) => row.status === 'SKIP_ALREADY_PRICE_RESOLVED').length,
      ownershipCollisions: outcomes.filter((row) => row.status === 'HOLD_PRODUCT_ALREADY_OWNED').length,
    }),
    reasons: Object.freeze(reasons),
    candidateDigest,
    mappingCandidates: Object.freeze(mappingCandidates),
    directlyPriceable: Object.freeze(direct),
    baseLaneReview: Object.freeze(baseLaneReview),
    resolvedPriceUnavailable: Object.freeze(resolvedUnpriced),
    held: Object.freeze(held),
    rows: Object.freeze(outcomes),
  });
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await build(db);
    const dir = process.env.RUNNER_TEMP || process.cwd();
    await writeFile(`${dir}/swsh-promos-phase2-variant-audit.json`, JSON.stringify(report, null, 2));
    await writeFile(`${dir}/swsh-promos-phase2-candidates.csv`, toCsv(report.mappingCandidates));
    await writeFile(`${dir}/swsh-promos-phase2-held.csv`, toCsv(report.held));
    console.log(JSON.stringify({
      status: report.status,
      productionWrites: report.productionWrites,
      source: report.source,
      counts: report.counts,
      reasons: report.reasons,
      candidateDigest: report.candidateDigest,
    }, null, 2));
    await db.query('COMMIT');
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
