import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const key=(...parts)=>parts.join('|');
const stableId=(prefix,parts)=>prefix+'_'+createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24);
const sourceVariantFor=Object.freeze({standard:'normal',holo:'holo'});

function findBalancedEnd(source,start,openChar,closeChar){
  if(source[start]!==openChar)return -1;
  let depth=0,quote=null,escaped=false,lineComment=false,blockComment=false;
  for(let i=start;i<source.length;i++){
    const c=source[i],n=source[i+1];
    if(lineComment){if(c==='\n')lineComment=false;continue;}
    if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++;}continue;}
    if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote=null;continue;}
    if(c==='/'&&n==='/'){lineComment=true;i++;continue;}
    if(c==='/'&&n==='*'){blockComment=true;i++;continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c===openChar)depth++;else if(c===closeChar){depth--;if(depth===0)return i;}
  }
  return -1;
}
function balancedAfter(source,regex,openChar,closeChar){const m=regex.exec(source);if(!m)return null;const start=source.indexOf(openChar,m.index+m[0].length-1);if(start<0)return null;const end=findBalancedEnd(source,start,openChar,closeChar);return end<0?null:source.slice(start,end+1);}
function arrayProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\[`),'[',']');}
function objectProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\{`),'{','}');}
function quotedProperty(source,property){if(!source)return null;const m=new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);return m?m[2].trim():null;}
function topLevelObjects(arraySource){if(!arraySource||arraySource[0]!=='[')return[];const out=[];let i=1;while(i<arraySource.length-1){const open=arraySource.indexOf('{',i);if(open<0)break;const end=findBalancedEnd(arraySource,open,'{','}');if(end<0)break;out.push(arraySource.slice(open,end+1));i=end+1;}return out;}
function namesFromArray(source,property){const block=arrayProperty(source,property);if(!block)return[];return topLevelObjects(block).map(obj=>quotedProperty(objectProperty(obj,'name'),'en')).filter(Boolean);}
function tcgdexDescriptorEvidence(card){try{const source=fs.readFileSync(card.sourcePath,'utf8');return [...new Set([...namesFromArray(source,'attacks'),...namesFromArray(source,'abilities')].map(normaliseComparableName).filter(Boolean))].sort();}catch{return[];}}
function stripProviderDescriptors(name){let value=String(name||'').trim().replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female').replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');const suffix=/\s+\[[^[\]]+\]\s*$/;while(suffix.test(value))value=value.replace(suffix,'').trim();return value;}
function providerDescriptorTerms(name){const groups=[...String(name||'').matchAll(/\[([^\]]+)\]/g)].map(m=>m[1]);const terms=[];for(const g of groups){for(const part of g.split('|')){const v=normaliseComparableName(part);if(v&&!/^\d+[a-z]?$/.test(v))terms.push(v);}}return [...new Set(terms)].sort();}
function sameTermSet(left,right){return left.length>0&&left.length===right.length&&left.every((v,i)=>v===right[i]);}

async function build(db){
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const tcgdexCards=new Map();for(const set of repo.sets)for(const card of set.cards)tcgdexCards.set(card.tcgdexCardId,card);
  const [{artifact:catalogue,products},{artifact:guide,snapshot}]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
  const {rows:sets}=await db.query(`SELECT s.id set_id,t.source_record_id tcgdex_set_id,cm.source_record_id cardmarket_expansion_override FROM fatedrop_card_sets s LEFT JOIN fatedrop_card_set_source_mappings t ON t.set_id=s.id AND t.source_name='tcgdex' LEFT JOIN fatedrop_card_set_source_mappings cm ON cm.set_id=s.id AND cm.source_name='cardmarket' WHERE s.verification_status='verified'`);
  const expansionBySet=new Map();
  for(const s of sets){const ev=s.tcgdex_set_id?repo.bySetId.get(s.tcgdex_set_id):null;const override=Number(s.cardmarket_expansion_override),sourceId=Number(ev?.cardmarketExpansionId);const id=Number.isSafeInteger(override)&&override>0?override:sourceId;if(Number.isSafeInteger(id)&&id>0)expansionBySet.set(s.set_id,id);}
  const {rows:ids}=await db.query(`SELECT DISTINCT ON (i.id) i.id,i.set_id,i.variant_code,p.name,t.source_record_id tcgdex_card_id FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex' WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN ('standard','holo') AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id) ORDER BY i.id,t.source_record_id`);
  const byExpansionBase=new Map();
  for(const p of products){const expansionId=Number(p.sourceExpansionId);if(!Number.isSafeInteger(expansionId)||expansionId<=0)continue;const base=normaliseComparableName(stripProviderDescriptors(p.name));if(!base)continue;const k=key(expansionId,base);const a=byExpansionBase.get(k)||[];a.push(p);byExpansionBase.set(k,a);}
  const {rows:existing}=await db.query(`SELECT card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const existingSource=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
  const existingCanonical=new Map(existing.map(r=>[key(r.card_identity_id,r.source_variant_key),String(r.source_record_id)]));
  const priceBy=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));
  const raw=[],ambiguous=[],unresolved=[],conflicts=[];
  for(const i of ids){
    const expansionId=expansionBySet.get(i.set_id);if(!expansionId){unresolved.push({id:i.id,reason:'no_expansion_scope'});continue;}
    const card=tcgdexCards.get(i.tcgdex_card_id);if(!card){unresolved.push({id:i.id,reason:'tcgdex_card_evidence_missing'});continue;}
    const evidence=tcgdexDescriptorEvidence(card);if(!evidence.length){unresolved.push({id:i.id,reason:'no_attack_or_ability_evidence'});continue;}
    const sameBase=byExpansionBase.get(key(expansionId,normaliseComparableName(i.name)))||[];if(sameBase.length<2){unresolved.push({id:i.id,reason:'not_a_multi_product_base_name_case'});continue;}
    const matched=sameBase.map(p=>({p,terms:providerDescriptorTerms(p.name)})).filter(x=>sameTermSet(x.terms,evidence));
    if(matched.length===0){unresolved.push({id:i.id,reason:'no_exact_descriptor_term_set_match'});continue;}
    if(matched.length>1){ambiguous.push({id:i.id,reason:'multiple_exact_descriptor_term_set_matches',products:matched.map(x=>String(x.p.sourceRecordId))});continue;}
    const p=matched[0].p,sourceRecordId=String(p.sourceRecordId),sourceVariantKey=sourceVariantFor[i.variant_code];
    const sk=key(sourceRecordId,sourceVariantKey),ck=key(i.id,sourceVariantKey);
    if(existingSource.has(sk)&&existingSource.get(sk)!==i.id){conflicts.push({id:i.id,reason:'source_owned',sourceRecordId});continue;}
    if(existingCanonical.has(ck)&&existingCanonical.get(ck)!==sourceRecordId){conflicts.push({id:i.id,reason:'canonical_owned',sourceRecordId});continue;}
    raw.push({id:stableId('fdcardmap',[i.id,'cardmarket',sourceRecordId,sourceVariantKey]),cardIdentityId:i.id,tcgdexCardId:i.tcgdex_card_id,sourceRecordId,sourceVariantKey,sourceVersion:catalogue.sha256,proof:{method:'scoped_expansion_exact_attack_ability_descriptor_set',cardmarketProductName:p.name,evidence}});
  }
  const sourceOwners=new Map(),canonicalOwners=new Map(),badSource=new Set(),badCanonical=new Set();
  for(const r of raw){const sk=key(r.sourceRecordId,r.sourceVariantKey),ck=key(r.cardIdentityId,r.sourceVariantKey);if(sourceOwners.has(sk)&&sourceOwners.get(sk)!==r.cardIdentityId)badSource.add(sk);else sourceOwners.set(sk,r.cardIdentityId);if(canonicalOwners.has(ck)&&canonicalOwners.get(ck)!==r.sourceRecordId)badCanonical.add(ck);else canonicalOwners.set(ck,r.sourceRecordId);}
  const safe=raw.filter(r=>!badSource.has(key(r.sourceRecordId,r.sourceVariantKey))&&!badCanonical.has(key(r.cardIdentityId,r.sourceVariantKey)));
  const priceable=safe.filter(r=>{const lane=r.sourceVariantKey==='normal'?'standard':'holo';const row=priceBy.get(r.sourceRecordId);return row&&hasMeaningfulCardmarketLane(row,lane);});
  return {status:'audit_complete',productionWrites:false,source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogue.sha256,cardmarketPriceGuideSha256:guide.sha256},counts:{eligibleUnmappedNormalHolo:ids.length,safeExactMappings:safe.length,priceableSafeMappings:new Set(priceable.map(r=>r.cardIdentityId)).size,ambiguous:ambiguous.length,unresolved:unresolved.length,conflicts:conflicts.length+badSource.size+badCanonical.size,batchSourceConflicts:badSource.size,batchCanonicalConflicts:badCanonical.size},candidates:safe,ambiguous,unresolved,conflicts};
}

async function persist(db,report){
  await db.query('BEGIN');
  try{
    for(const r of report.candidates){
      const source=await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,[r.sourceRecordId,r.sourceVariantKey]);
      if(source.rows[0]&&source.rows[0].card_identity_id!==r.cardIdentityId)throw new Error('Cardmarket source ownership changed');
      const canonical=await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2`,[r.cardIdentityId,r.sourceVariantKey]);
      if(canonical.rows[0]&&String(canonical.rows[0].source_record_id)!==r.sourceRecordId)throw new Error('Canonical Cardmarket mapping changed');
      await db.query(`INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) ON CONFLICT(id) DO NOTHING`,[r.id,r.cardIdentityId,r.sourceRecordId,r.sourceVariantKey,r.sourceVersion,Date.now()]);
    }
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});const db=await pool.connect();let report;
  try{report=await build(db);if(process.env.MAPPING_WRITE==='true'){await persist(db,report);report={...report,status:'write_complete',productionWrites:true};}}
  catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{db.release();await pool.end();await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-attack-ability-exact-recovery.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,counts:report.counts},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
