import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { getRootCardmarketProductId, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';

const POLICY = Object.freeze({
  standard: Object.freeze({ sourceVariantKey: 'normal', priceLane: 'standard' }),
  holo: Object.freeze({ sourceVariantKey: 'holo', priceLane: 'holo' }),
});

const key = (...parts) => parts.join('|');
const stableId = (prefix, parts) => `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;

function collector(value) {
  try { return normaliseCollectorNumber(value); } catch { return null; }
}

export function assessResolutionAwareRootCandidate({ identity, tcgdexCard, tcgdexSet, product, priceRow, sourceOwner }) {
  const policy = POLICY[identity?.variantCode];
  if (!policy) return Object.freeze({ status: 'HOLD_UNSUPPORTED_FINISH' });
  if (!tcgdexCard) return Object.freeze({ status: 'HOLD_TCGDEX_CARD_MISSING' });
  if (!tcgdexSet) return Object.freeze({ status: 'HOLD_TCGDEX_SET_MISSING' });
  if (!rootProductNameMatches(identity.name, tcgdexCard.name)) return Object.freeze({ status: 'HOLD_TCGDEX_NAME_MISMATCH' });
  if (collector(identity.collectorNumber) !== collector(tcgdexCard.localId)) return Object.freeze({ status: 'HOLD_TCGDEX_COLLECTOR_MISMATCH' });

  const expansionId = Number(tcgdexSet.cardmarketExpansionId);
  if (!Number.isSafeInteger(expansionId) || expansionId <= 0) return Object.freeze({ status: 'HOLD_SET_SCOPE_MISSING' });
  if (!product) return Object.freeze({ status: 'HOLD_PRODUCT_MISSING_FROM_OFFICIAL_CATALOGUE' });
  if (Number(product.sourceExpansionId) !== expansionId) return Object.freeze({ status: 'HOLD_EXPANSION_MISMATCH' });
  if (!rootProductNameMatches(identity.name, product.name)) return Object.freeze({ status: 'HOLD_PRODUCT_NAME_MISMATCH' });
  if (!priceRow || !hasMeaningfulCardmarketLane(priceRow, policy.priceLane)) return Object.freeze({ status: 'HOLD_PRICE_LANE_MISSING' });
  if (sourceOwner && sourceOwner !== identity.cardIdentityId) return Object.freeze({ status: 'HOLD_PRODUCT_ALREADY_OWNED', existingCardIdentityId: sourceOwner });

  return Object.freeze({
    status: 'SAFE_MAPPING_CANDIDATE',
    sourceVariantKey: policy.sourceVariantKey,
    priceLane: policy.priceLane,
    sourceExpansionId: expansionId,
  });
}

export async function build(db, { sources, repoEvidence } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO, { includeCards: true });
  const cardById = new Map();
  const setByCardId = new Map();
  for (const set of repo.sets) {
    for (const card of set.cards) {
      cardById.set(card.tcgdexCardId, card);
      setByCardId.set(card.tcgdexCardId, set);
    }
  }

  const [{ artifact: catalogue, products }, { artifact: guide, snapshot }] = await Promise.all([
    sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue(),
    sources?.guide ?? fetchCardmarketPokemonPriceGuide(),
  ]);
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
          AND greatest(o.market_price,o.trend_price,o.avg_1d,o.avg_7d,o.avg_30d)>0
      )
    ORDER BY i.id`);

  const { rows: existing } = await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const owners = new Map();
  for (const row of existing) {
    const sourceKey = key(row.source_record_id,row.source_variant_key);
    const prior = owners.get(sourceKey);
    owners.set(sourceKey, prior && prior !== row.card_identity_id ? '__CONFLICT__' : row.card_identity_id);
  }

  const reasons = {};
  const raw = [];
  const resolutions = [];
  const bump = (name) => { reasons[name] = (reasons[name] || 0) + 1; };

  for (const row of identities) {
    const identity = {
      cardIdentityId: row.id,
      variantCode: row.variant_code,
      name: row.name,
      collectorNumber: row.collector_number,
      classifierState: row.classifier_state || null,
    };
    if (!Array.isArray(row.tcgdex_card_ids) || row.tcgdex_card_ids.length !== 1) {
      bump('HOLD_TCGDEX_LINK_COUNT');
      resolutions.push({ identity, status: 'HOLD_TCGDEX_LINK_COUNT', tcgdexCardIds: row.tcgdex_card_ids });
      continue;
    }
    const tcgdexCardId = row.tcgdex_card_ids[0];
    const card = cardById.get(tcgdexCardId);
    const set = setByCardId.get(tcgdexCardId);
    if (!card || !set) {
      bump('HOLD_TCGDEX_EVIDENCE_MISSING');
      resolutions.push({ identity, status: 'HOLD_TCGDEX_EVIDENCE_MISSING', tcgdexCardId });
      continue;
    }
    const rootProductId = getRootCardmarketProductId(card);
    if (!rootProductId) {
      bump('HOLD_NO_ROOT_CARDMARKET_PRODUCT');
      resolutions.push({ identity, status: 'HOLD_NO_ROOT_CARDMARKET_PRODUCT', tcgdexCardId });
      continue;
    }
    const sourceRecordId = String(rootProductId);
    const policy = POLICY[identity.variantCode];
    const sourceOwner = owners.get(key(sourceRecordId,policy.sourceVariantKey));
    const assessment = assessResolutionAwareRootCandidate({
      identity,
      tcgdexCard: card,
      tcgdexSet: set,
      product: productById.get(sourceRecordId),
      priceRow: priceById.get(sourceRecordId),
      sourceOwner,
    });
    if (assessment.status !== 'SAFE_MAPPING_CANDIDATE') {
      bump(assessment.status);
      resolutions.push({ identity, tcgdexCardId, sourceRecordId, ...assessment });
      continue;
    }
    raw.push({
      id: stableId('fdcardmap',[identity.cardIdentityId,'cardmarket',sourceRecordId,assessment.sourceVariantKey]),
      cardIdentityId: identity.cardIdentityId,
      name: identity.name,
      collectorNumber: identity.collectorNumber,
      variantCode: identity.variantCode,
      tcgdexCardId,
      sourceRecordId,
      sourceVariantKey: assessment.sourceVariantKey,
      sourceVersion: catalogue.sha256,
      cardmarketProductName: productById.get(sourceRecordId).name,
      sourceExpansionId: assessment.sourceExpansionId,
      priceLane: assessment.priceLane,
      proof: {
        method: 'tcgdex_exact_card_root_product_plus_locked_identity_finish_and_official_cardmarket_price_lane',
        tcgdexRevision: process.env.TCGDEX_REVISION || null,
        tcgdexSetId: set.tcgdexSetId,
        tcgdexSetSourcePath: set.sourcePath,
        tcgdexCardSourcePath: card.sourcePath,
        finishProofSource: 'canonical_fatedrop_identity',
      },
    });
    resolutions.push({ identity, tcgdexCardId, sourceRecordId, status: assessment.status });
  }

  const batchOwners = new Map();
  const collisionKeys = new Set();
  for (const row of raw) {
    const sourceKey = key(row.sourceRecordId,row.sourceVariantKey);
    const prior = batchOwners.get(sourceKey);
    if (prior && prior !== row.cardIdentityId) collisionKeys.add(sourceKey);
    else batchOwners.set(sourceKey,row.cardIdentityId);
  }
  const candidates = raw.filter((row) => !collisionKeys.has(key(row.sourceRecordId,row.sourceVariantKey)));
  if (raw.length !== candidates.length) reasons.HOLD_BATCH_SOURCE_COLLISION = raw.length - candidates.length;

  return {
    status: 'audit_complete', productionWrites: false,
    source: { tcgdexRevision: process.env.TCGDEX_REVISION || null, cardmarketCatalogueSha256: catalogue.sha256, cardmarketPriceGuideSha256: guide.sha256 },
    policy: {
      exactSingleTcgdexCardRequired: true,
      exactNameAndCollectorRequired: true,
      explicitTcgdexCardmarketSetScopeRequired: true,
      officialCardmarketProductRequired: true,
      lockedCanonicalFinishSelectsPriceLane: true,
      meaningfulTargetPriceLaneRequired: true,
      sourceOwnershipFailClosed: true,
      invalidAndUnresolvedResolutionStatesExcluded: true,
      zeroGuess: true,
    },
    counts: { sectionB: identities.length, preBatchSafe: raw.length, safeExactMappings: candidates.length, held: identities.length - candidates.length, batchCollisionKeys: collisionKeys.size },
    reasons, candidates, resolutions,
  };
}

export async function persist(db, report) {
  if (report.status !== 'audit_complete') throw new Error('Recovery audit is not complete');
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fatedrop-resolution-aware-root-recovery'))`);
    let insertedMappings = 0;
    for (const row of report.candidates) {
      const target = await db.query(`
        SELECT i.id,i.variant_code,i.language_code,i.verification_status,rs.classifier_state
        FROM fatedrop_card_identities i
        LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=i.id
        WHERE i.id=$1 FOR UPDATE`,[row.cardIdentityId]);
      const current = target.rows[0];
      if (!current || current.verification_status!=='verified' || current.language_code!=='en' || current.variant_code!==row.variantCode) throw new Error(`Canonical identity changed: ${row.cardIdentityId}`);
      if (['INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'].includes(current.classifier_state)) throw new Error(`Resolution state changed: ${row.cardIdentityId}`);
      const canonical = await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 FOR UPDATE`,[row.cardIdentityId]);
      if (canonical.rowCount) throw new Error(`Identity already mapped: ${row.cardIdentityId}`);
      const source = await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2 FOR UPDATE`,[row.sourceRecordId,row.sourceVariantKey]);
      if (source.rowCount) throw new Error(`Source key already owned: ${row.sourceRecordId}/${row.sourceVariantKey}`);
      const now=Date.now();
      const result=await db.query(`INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) RETURNING id`,[row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceVersion,now]);
      insertedMappings += result.rowCount;
    }
    await db.query('COMMIT');
    return { insertedMappings };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  if (!process.env.TCGDEX_REPO) throw new Error('TCGDEX_REPO is required');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();
  let report;
  try {
    report=await build(db);
    const expected=Number(process.env.EXPECTED_SECTION_B||0);
    if(expected>0 && report.counts.sectionB!==expected) throw new Error(`Section B drift: expected ${expected}, found ${report.counts.sectionB}`);
    if(process.env.MAPPING_WRITE==='true') {
      const persistence=await persist(db,report);
      report={...report,status:'write_complete',productionWrites:true,persistence};
    }
  } catch(error) {
    report={status:'blocked',productionWrites:false,error:error instanceof Error?error.message:String(error)};
    process.exitCode=1;
  } finally {
    db.release(); await pool.end();
  }
  await writeFile(`${process.env.RUNNER_TEMP||'.'}/cardmarket-resolution-aware-root-recovery.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,productionWrites:report.productionWrites,counts:report.counts,reasons:report.reasons,persistence:report.persistence},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
