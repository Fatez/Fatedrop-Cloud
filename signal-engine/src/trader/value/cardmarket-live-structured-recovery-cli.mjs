import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const CM_VARIANT = Object.freeze({ standard:'normal', holo:'holo' });
const CM_LANE = Object.freeze({ standard:'standard', holo:'holo' });
const stableId=(prefix,parts)=>prefix+'_'+createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24);
const key=(...parts)=>parts.join('|');

async function build(db) {
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:false});
  const [{artifact:cat,products},{artifact:guide,snapshot}]=await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()
  ]);
  const {rows:sets}=await db.query(`
    SELECT sm.set_id,sm.source_record_id tcgdex_set_id
    FROM fatedrop_card_set_source_mappings sm
    JOIN fatedrop_card_sets s ON s.id=sm.set_id
    WHERE sm.source_name='tcgdex' AND s.verification_status='verified'`);
  const {rows:ids}=await db.query(`
    SELECT i.id,i.set_id,i.variant_code,p.collector_number,p.name
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.verification_status='verified' AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id)`);
  const {rows:existing}=await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);

  const expansionBySet=new Map();
  for(const s of sets){
    const ev=repo.bySetId.get(s.tcgdex_set_id);
    const expansionId=Number(ev?.cardmarketExpansionId);
    if(Number.isSafeInteger(expansionId)&&expansionId>0) expansionBySet.set(s.set_id,{expansionId,tcgdexSetId:s.tcgdex_set_id});
  }
  const byStructured=new Map();
  for(const p of products){
    const expansionId=Number(p.sourceExpansionId);
    if(!Number.isSafeInteger(expansionId)||expansionId<=0) continue;
    const parsed=parseCardmarketSingleProductName(p.name);
    if(!parsed) continue;
    const k=key(expansionId,parsed.collectorNumber,normaliseComparableName(parsed.cardName));
    const a=byStructured.get(k)||[]; a.push({p,parsed}); byStructured.set(k,a);
  }
  const existingSource=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
  const existingCanonical=new Map(existing.map(r=>[key(r.card_identity_id,r.source_variant_key),r.source_record_id]));
  const raw=[],unresolved=[],ambiguous=[],conflicts=[];
  for(const i of ids){
    const set=expansionBySet.get(i.set_id);
    if(!set){unresolved.push({id:i.id,reason:'no_explicit_cardmarket_expansion'});continue;}
    let collector; try{collector=normaliseCollectorNumber(i.collector_number);}catch{unresolved.push({id:i.id,reason:'invalid_collector'});continue;}
    const matches=byStructured.get(key(set.expansionId,collector,normaliseComparableName(i.name)))||[];
    if(matches.length===0){unresolved.push({id:i.id,reason:'no_exact_structured_product'});continue;}
    if(matches.length!==1){ambiguous.push({id:i.id,reason:'multiple_exact_structured_products',products:matches.map(x=>x.p.sourceRecordId)});continue;}
    const sourceRecordId=String(matches[0].p.sourceRecordId), sourceVariantKey=CM_VARIANT[i.variant_code];
    const sk=key(sourceRecordId,sourceVariantKey), ck=key(i.id,sourceVariantKey);
    if(existingSource.has(sk)&&existingSource.get(sk)!==i.id){conflicts.push({id:i.id,reason:'source_owned',sourceRecordId});continue;}
    if(existingCanonical.has(ck)&&String(existingCanonical.get(ck))!==sourceRecordId){conflicts.push({id:i.id,reason:'canonical_owned',sourceRecordId});continue;}
    raw.push({id:stableId('fdcardmap',[i.id,'cardmarket',sourceRecordId,sourceVariantKey]),cardIdentityId:i.id,sourceRecordId,sourceVariantKey,sourceVersion:cat.sha256});
  }
  const sourceOwners=new Map(),canonicalOwners=new Map(),badSource=new Set(),badCanonical=new Set();
  for(const r of raw){
    const sk=key(r.sourceRecordId,r.sourceVariantKey),ck=key(r.cardIdentityId,r.sourceVariantKey);
    if(sourceOwners.has(sk)&&sourceOwners.get(sk)!==r.cardIdentityId) badSource.add(sk); else sourceOwners.set(sk,r.cardIdentityId);
    if(canonicalOwners.has(ck)&&canonicalOwners.get(ck)!==r.sourceRecordId) badCanonical.add(ck); else canonicalOwners.set(ck,r.sourceRecordId);
  }
  const safe=raw.filter(r=>!badSource.has(key(r.sourceRecordId,r.sourceVariantKey))&&!badCanonical.has(key(r.cardIdentityId,r.sourceVariantKey)));
  const priceBy=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));
  const priceable=safe.filter(r=>{const p=priceBy.get(r.sourceRecordId);return p&&hasMeaningfulCardmarketLane(p,CM_LANE[r.sourceVariantKey==='normal'?'standard':'holo']);});
  return {status:'clean_subset_available',productionWrites:false,source:{catalogueSha256:cat.sha256,priceGuideSha256:guide.sha256,tcgdexRevision:process.env.TCGDEX_REVISION},counts:{eligibleUnmappedNormalHolo:ids.length,safeExactMappings:safe.length,newPriceableIdentities:new Set(priceable.map(r=>r.cardIdentityId)).size,unresolved:unresolved.length,ambiguous:ambiguous.length,conflicts:conflicts.length+badSource.size+badCanonical.size},candidates:safe,unresolved,ambiguous,conflicts};
}
async function persist(db,report){
  await db.query('BEGIN');
  try{
    for(const r of report.candidates){
      const collision=await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,[r.sourceRecordId,r.sourceVariantKey]);
      if(collision.rows[0]&&collision.rows[0].card_identity_id!==r.cardIdentityId) throw new Error('source ownership changed');
      await db.query(`INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at)
        VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) ON CONFLICT(id) DO NOTHING`,[r.id,r.cardIdentityId,r.sourceRecordId,r.sourceVariantKey,r.sourceVersion,Date.now()]);
    }
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
}
async function main(){
 validateProductionTarget(process.env.DATABASE_URL);
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});const db=await pool.connect();let report;
 try{report=await build(db);if(process.env.MAPPING_WRITE==='true'){await persist(db,report);report={...report,productionWrites:true};}}
 catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
 finally{db.release();await pool.end();await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-live-structured-recovery.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report.counts||report));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
