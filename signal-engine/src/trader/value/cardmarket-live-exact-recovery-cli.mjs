import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { loadTcgdexRepositoryEvidence, auditExplicitCardmarketMappings, indexCardmarketProducts } from './tcgdex-repository-cardmarket-evidence.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const FINISH = Object.freeze({ normal:'standard', holo:'holo', reverse:'reverse-holo' });
const PRICE_LANE = Object.freeze({ normal:'standard', holo:'holo' });

function stableId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24)}`;
}

function key(recordId, variant) { return `${recordId}|${variant}`; }

export async function buildExactRecovery({ db, tcgdexRepo }) {
  const repo = loadTcgdexRepositoryEvidence(tcgdexRepo, { includeCards:true });
  const [{ artifact: catalogueArtifact, products }, { artifact: priceArtifact, snapshot }] = await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productsIndex = indexCardmarketProducts(products);
  const priceByProduct = new Map(snapshot.priceGuides.map(r => [String(r.idProduct), r]));

  const { rows:setRows } = await db.query(`
    SELECT
      t.source_record_id AS tcgdex_set_id,
      s.id AS set_id,
      s.name AS set_name,
      cm.source_record_id AS cardmarket_expansion_override
    FROM fatedrop_card_set_source_mappings t
    JOIN fatedrop_card_sets s ON s.id=t.set_id
    LEFT JOIN fatedrop_card_set_source_mappings cm
      ON cm.set_id=s.id AND cm.source_name='cardmarket'
    WHERE t.source_name='tcgdex' AND s.verification_status='verified'`);
  const { rows:tcgRows } = await db.query(`
    SELECT m.source_record_id,m.source_variant_key,m.card_identity_id,c.variant_code,c.set_id
    FROM fatedrop_card_source_mappings m
    JOIN fatedrop_card_identities c ON c.id=m.card_identity_id
    WHERE m.source_name='tcgdex' AND c.verification_status='verified' AND c.language_code='en'`);
  const { rows:cmRows } = await db.query(`
    SELECT id,source_record_id,source_variant_key,card_identity_id
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);

  const canonicalByTcgdex = new Map();
  for (const r of tcgRows) {
    const k=key(r.source_record_id,r.source_variant_key);
    if (canonicalByTcgdex.has(k) && canonicalByTcgdex.get(k).cardIdentityId!==r.card_identity_id) throw new Error('Duplicate TCGdex canonical source key: '+k);
    canonicalByTcgdex.set(k,{cardIdentityId:r.card_identity_id,variantCode:r.variant_code,setId:r.set_id});
  }
  const cmBySource=new Map(), cmByCanonicalVariant=new Map();
  for (const r of cmRows) {
    cmBySource.set(key(r.source_record_id,r.source_variant_key),r);
    cmByCanonicalVariant.set(key(r.card_identity_id,r.source_variant_key),r);
  }

  const candidates=[], conflicts=[], unresolvedSets=[];
  for (const setRow of setRows) {
    const sourceSet=repo.bySetId.get(setRow.tcgdex_set_id);
    if (!sourceSet) { unresolvedSets.push({setId:setRow.set_id,tcgdexSetId:setRow.tcgdex_set_id,reason:'missing_from_pinned_tcgdex_repo'}); continue; }
    const override=Number(setRow.cardmarket_expansion_override);
    const evidenceSet=(Number.isSafeInteger(override)&&override>0)
      ? {...sourceSet,cardmarketExpansionId:override}
      : sourceSet;
    const audit=auditExplicitCardmarketMappings(evidenceSet,productsIndex.byId,productsIndex.byExpansion);
    if (audit.status!=='proven') { unresolvedSets.push({setId:setRow.set_id,tcgdexSetId:setRow.tcgdex_set_id,reason:audit.reason}); continue; }
    for (const ev of audit.mappings || []) {
      if (ev.status!=='proven') continue;
      const variant=String(ev.variant?.type||'').trim();
      if (!PRICE_LANE[variant]) continue;
      const canonical=canonicalByTcgdex.get(key(ev.tcgdexCardId,variant));
      if (!canonical) continue;
      if (canonical.variantCode!==FINISH[variant]) {
        conflicts.push({type:'canonical_finish_mismatch',tcgdexCardId:ev.tcgdexCardId,variant,cardIdentityId:canonical.cardIdentityId,variantCode:canonical.variantCode});
        continue;
      }
      const sourceRecordId=String(ev.cardmarketProductId);
      const sourceKey=key(sourceRecordId,variant);
      const canonicalKey=key(canonical.cardIdentityId,variant);
      const existingSource=cmBySource.get(sourceKey);
      const existingCanonical=cmByCanonicalVariant.get(canonicalKey);
      if (existingSource) {
        if (existingSource.card_identity_id!==canonical.cardIdentityId) conflicts.push({type:'source_owned_by_other_identity',sourceRecordId,variant,cardIdentityId:canonical.cardIdentityId,existingCardIdentityId:existingSource.card_identity_id});
        continue;
      }
      if (existingCanonical) {
        if (String(existingCanonical.source_record_id)!==sourceRecordId) conflicts.push({type:'identity_variant_owned_by_other_product',sourceRecordId,variant,cardIdentityId:canonical.cardIdentityId,existingSourceRecordId:existingCanonical.source_record_id});
        continue;
      }
      candidates.push({
        id:stableId('fdcardmap',[canonical.cardIdentityId,'cardmarket',sourceRecordId,variant]),
        cardIdentityId:canonical.cardIdentityId,
        sourceName:'cardmarket',
        sourceRecordId,
        sourceVariantKey:variant,
        sourceVersion:catalogueArtifact.sha256,
        proof:{method:'tcgdex_explicit_product_id_verified_in_official_cardmarket_catalogue',tcgdexCardId:ev.tcgdexCardId,nameMatchBasis:ev.nameMatchBasis},
      });
    }
  }

  const unique=[], seenSource=new Map(), seenCanonical=new Map();
  for (const row of candidates) {
    const sk=key(row.sourceRecordId,row.sourceVariantKey), ck=key(row.cardIdentityId,row.sourceVariantKey);
    const sp=seenSource.get(sk), cp=seenCanonical.get(ck);
    if (sp && sp.cardIdentityId!==row.cardIdentityId) { conflicts.push({type:'candidate_source_conflict',key:sk}); continue; }
    if (cp && cp.sourceRecordId!==row.sourceRecordId) { conflicts.push({type:'candidate_canonical_conflict',key:ck}); continue; }
    if (!sp && !cp) { seenSource.set(sk,row); seenCanonical.set(ck,row); unique.push(row); }
  }

  let priceable=0, noGuideLane=0;
  for (const row of unique) {
    const lane=PRICE_LANE[row.sourceVariantKey];
    const priceRow=priceByProduct.get(row.sourceRecordId);
    if (priceRow && hasMeaningfulCardmarketLane(priceRow,lane)) priceable++;
    else noGuideLane++;
  }

  const conflictedCanonicalKeys = new Set();
  const conflictedSourceKeys = new Set();
  for (const conflict of conflicts) {
    if (conflict.cardIdentityId && conflict.variant) conflictedCanonicalKeys.add(key(conflict.cardIdentityId, conflict.variant));
    if (conflict.sourceRecordId && conflict.variant) conflictedSourceKeys.add(key(conflict.sourceRecordId, conflict.variant));
    if (conflict.key) {
      if (conflict.type === 'candidate_source_conflict') conflictedSourceKeys.add(conflict.key);
      if (conflict.type === 'candidate_canonical_conflict') conflictedCanonicalKeys.add(conflict.key);
    }
  }
  const safeCandidates = unique.filter((row) =>
    !conflictedCanonicalKeys.has(key(row.cardIdentityId, row.sourceVariantKey))
    && !conflictedSourceKeys.has(key(row.sourceRecordId, row.sourceVariantKey)));
  const heldCandidates = unique.filter((row) => !safeCandidates.includes(row));

  return {
    status: conflicts.length ? 'clean_subset_available' : 'clean',
    productionWrites:false,
    source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogueArtifact.sha256,cardmarketPriceGuideSha256:priceArtifact.sha256},
    before:{exactCardmarketMappings:cmRows.length,exactMappedIdentities:new Set(cmRows.map(r=>r.card_identity_id)).size},
    candidates:safeCandidates,
    heldCandidates,
    counts:{verifiedSets:setRows.length,newExactMappings:unique.length,safeExactMappings:safeCandidates.length,heldExactMappings:heldCandidates.length,newMappedIdentities:new Set(safeCandidates.map(r=>r.cardIdentityId)).size,newPriceableIdentities:new Set(safeCandidates.filter(r=>{const p=priceByProduct.get(r.sourceRecordId);return p&&hasMeaningfulCardmarketLane(p,PRICE_LANE[r.sourceVariantKey]);}).map(r=>r.cardIdentityId)).size,priceableRows:safeCandidates.filter(r=>{const p=priceByProduct.get(r.sourceRecordId);return p&&hasMeaningfulCardmarketLane(p,PRICE_LANE[r.sourceVariantKey]);}).length,noGuideLane:safeCandidates.filter(r=>{const p=priceByProduct.get(r.sourceRecordId);return !(p&&hasMeaningfulCardmarketLane(p,PRICE_LANE[r.sourceVariantKey]));}).length,conflicts:conflicts.length,unresolvedSets:unresolvedSets.length},
    conflicts,unresolvedSets,
  };
}

export async function persistExactRecovery(db, report) {
  if (!['clean','clean_subset_available'].includes(report.status)) throw new Error('Exact recovery has no safe persistence subset');
  await db.query('BEGIN');
  try {
    for (const row of report.candidates) {
      const sourceCheck=await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,[row.sourceRecordId,row.sourceVariantKey]);
      if (sourceCheck.rows[0] && sourceCheck.rows[0].card_identity_id!==row.cardIdentityId) throw new Error('Cardmarket source key changed ownership');
      const canonicalCheck=await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2`,[row.cardIdentityId,row.sourceVariantKey]);
      if (canonicalCheck.rows[0] && String(canonicalCheck.rows[0].source_record_id)!==row.sourceRecordId) throw new Error('Canonical Cardmarket mapping changed');
      await db.query(`INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at)
        VALUES ($1,$2,'cardmarket',$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING`,[row.id,row.cardIdentityId,row.sourceRecordId,row.sourceVariantKey,row.sourceVersion,Date.now()]);
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  return {saved:report.candidates.length};
}

async function main() {
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();
  const out=process.env.RUNNER_TEMP||'.';
  let report;
  try {
    report=await buildExactRecovery({db,tcgdexRepo:process.env.TCGDEX_REPO});
    if (process.env.MAPPING_WRITE==='true') {
      const result=await persistExactRecovery(db,report);
      report={...report,productionWrites:true,persistence:result};
    }
  } catch (e) {
    report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};
    process.exitCode=1;
  } finally {
    db.release(); await pool.end();
    await writeFile(`${out}/cardmarket-live-exact-recovery.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.counts||report));
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
