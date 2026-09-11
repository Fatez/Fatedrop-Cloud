import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const stableId=(prefix,parts)=>prefix+'_'+createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24);
const key=(...parts)=>parts.join('|');
const sourceVariantFor=Object.freeze({standard:'normal',holo:'holo'});

function stripProviderDescriptors(name){
  let value=String(name||'').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');
  const square=/\s+\[[^[\]]+\]\s*$/;
  while(square.test(value)) value=value.replace(square,'').trim();
  return value;
}

function ignorableProductName(name){
  const text=String(name||'').toLowerCase();
  return /online code card|booster|theme deck|2-pack|checklane|blister|deck exclusive|league promo/.test(text);
}

async function audit(db){
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:false});
  const [{artifact:cat,products},{artifact:guide,snapshot}]=await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()
  ]);

  const {rows:sets}=await db.query(`
    SELECT s.id set_id,sm.source_record_id tcgdex_set_id
    FROM fatedrop_card_sets s
    JOIN fatedrop_card_set_source_mappings sm ON sm.set_id=s.id AND sm.source_name='tcgdex'
    WHERE s.verification_status='verified'`);
  const expansionBySet=new Map();
  for(const s of sets){
    const ev=repo.bySetId.get(s.tcgdex_set_id);
    const expansionId=Number(ev?.cardmarketExpansionId);
    if(Number.isSafeInteger(expansionId)&&expansionId>0) expansionBySet.set(s.set_id,expansionId);
  }

  const {rows:ids}=await db.query(`
    SELECT i.id,i.set_id,i.printing_id,i.variant_code,p.name,p.collector_number
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.verification_status='verified' AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )`);

  const providerByExpansionName=new Map();
  for(const p of products){
    const expansionId=Number(p.sourceExpansionId);
    if(!Number.isSafeInteger(expansionId)||expansionId<=0) continue;
    if(ignorableProductName(p.name)) continue;
    const base=normaliseComparableName(stripProviderDescriptors(p.name));
    if(!base) continue;
    const k=key(expansionId,base);
    const a=providerByExpansionName.get(k)||[];
    a.push(p);providerByExpansionName.set(k,a);
  }

  const canonicalByExpansionName=new Map();
  for(const i of ids){
    const expansionId=expansionBySet.get(i.set_id);
    if(!expansionId) continue;
    const k=key(expansionId,normaliseComparableName(i.name));
    const a=canonicalByExpansionName.get(k)||[];
    a.push(i);canonicalByExpansionName.set(k,a);
  }

  const {rows:existing}=await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const existingSource=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
  const existingCanonical=new Map(existing.map(r=>[key(r.card_identity_id,r.source_variant_key),r.source_record_id]));

  const raw=[],ambiguous=[],unresolved=[],conflicts=[];
  for(const [k,canonicalRows] of canonicalByExpansionName){
    const providerRows=providerByExpansionName.get(k)||[];
    const printingIds=new Set(canonicalRows.map(r=>r.printing_id));
    if(providerRows.length!==1){
      if(providerRows.length===0) unresolved.push({key:k,canonicalIdentities:canonicalRows.map(r=>r.id),reason:'no_exact_provider_base_name'});
      else ambiguous.push({key:k,canonicalIdentities:canonicalRows.map(r=>r.id),providerProducts:providerRows.map(r=>String(r.sourceRecordId)),reason:'multiple_provider_products_same_scoped_name'});
      continue;
    }
    if(printingIds.size!==1){
      ambiguous.push({key:k,canonicalIdentities:canonicalRows.map(r=>r.id),providerProducts:[String(providerRows[0].sourceRecordId)],reason:'multiple_canonical_printings_same_scoped_name'});
      continue;
    }
    const p=providerRows[0],sourceRecordId=String(p.sourceRecordId);
    for(const i of canonicalRows){
      const sourceVariantKey=sourceVariantFor[i.variant_code];
      const sk=key(sourceRecordId,sourceVariantKey),ck=key(i.id,sourceVariantKey);
      if(existingSource.has(sk)&&existingSource.get(sk)!==i.id){conflicts.push({id:i.id,sourceRecordId,sourceVariantKey,reason:'source_owned'});continue;}
      if(existingCanonical.has(ck)&&String(existingCanonical.get(ck))!==sourceRecordId){conflicts.push({id:i.id,sourceRecordId,sourceVariantKey,reason:'canonical_owned'});continue;}
      raw.push({
        id:stableId('fdcardmap',[i.id,'cardmarket',sourceRecordId,sourceVariantKey]),
        cardIdentityId:i.id,sourceRecordId,sourceVariantKey,sourceVersion:cat.sha256,
        proof:{method:'scoped_expansion_unique_name_unique_printing',cardmarketProductName:p.name,canonicalName:i.name,canonicalCollectorNumber:i.collector_number}
      });
    }
  }

  const sourceOwners=new Map(),canonicalOwners=new Map(),badSource=new Set(),badCanonical=new Set();
  for(const r of raw){
    const sk=key(r.sourceRecordId,r.sourceVariantKey),ck=key(r.cardIdentityId,r.sourceVariantKey);
    if(sourceOwners.has(sk)&&sourceOwners.get(sk)!==r.cardIdentityId) badSource.add(sk); else sourceOwners.set(sk,r.cardIdentityId);
    if(canonicalOwners.has(ck)&&canonicalOwners.get(ck)!==r.sourceRecordId) badCanonical.add(ck); else canonicalOwners.set(ck,r.sourceRecordId);
  }
  const safe=raw.filter(r=>!badSource.has(key(r.sourceRecordId,r.sourceVariantKey))&&!badCanonical.has(key(r.cardIdentityId,r.sourceVariantKey)));
  const priceBy=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));
  const priceable=safe.filter(r=>{
    const lane=r.sourceVariantKey==='normal'?'standard':'holo';
    const p=priceBy.get(r.sourceRecordId);
    return p&&hasMeaningfulCardmarketLane(p,lane);
  });

  return {
    status:'audit_complete',productionWrites:false,
    source:{tcgdexRevision:process.env.TCGDEX_REVISION,cardmarketCatalogueSha256:cat.sha256,cardmarketPriceGuideSha256:guide.sha256},
    counts:{
      eligibleUnmappedNormalHolo:ids.length,
      safeUniqueNameMappings:safe.length,
      safeUniqueCards:new Set(safe.map(r=>r.cardIdentityId)).size,
      newPriceableIdentities:new Set(priceable.map(r=>r.cardIdentityId)).size,
      ambiguousGroups:ambiguous.length,
      unresolvedGroups:unresolved.length,
      conflicts:conflicts.length+badSource.size+badCanonical.size
    },
    candidates:safe,ambiguous,unresolved,conflicts
  };
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();let report;
  try{report=await audit(db);}
  catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{
    db.release();await pool.end();
    await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-nameonly-unique-recovery.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.counts||report,null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
