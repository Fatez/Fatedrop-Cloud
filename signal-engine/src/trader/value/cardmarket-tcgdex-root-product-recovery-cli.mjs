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

const key=(...p)=>p.join('|');
const stableId=(prefix,parts)=>`${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24)}`;
const sourceVariantFor=Object.freeze({standard:'normal',holo:'holo'});
const laneFor=Object.freeze({standard:'standard',holo:'holo'});
const targetTypeFor=Object.freeze({standard:'normal',holo:'holo'});
const SP_MARKERS=new Set(['G','GL','FB','C','E4','M']);

function findBalancedEnd(source,start,openChar,closeChar){if(source[start]!==openChar)return-1;let depth=0,quote=null,escaped=false,lineComment=false,blockComment=false;for(let i=start;i<source.length;i++){const c=source[i],n=source[i+1];if(lineComment){if(c==='\n')lineComment=false;continue;}if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++;}continue;}if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote=null;continue;}if(c==='/'&&n==='/'){lineComment=true;i++;continue;}if(c==='/'&&n==='*'){blockComment=true;i++;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c===openChar)depth++;else if(c===closeChar){depth--;if(depth===0)return i;}}return-1;}
function balancedAfter(source,regex,openChar,closeChar){const m=regex.exec(source);if(!m)return null;const start=source.indexOf(openChar,m.index+m[0].length-1);if(start<0)return null;const end=findBalancedEnd(source,start,openChar,closeChar);return end<0?null:source.slice(start,end+1);}
function integerProperty(source,property){if(!source)return null;const m=new RegExp(`\\b${property}\\s*:\\s*(\\d+)`).exec(source);if(!m)return null;const n=Number(m[1]);return Number.isSafeInteger(n)&&n>0?n:null;}
function rootCardmarketId(card){try{const source=fs.readFileSync(card.sourcePath,'utf8');const root=balancedAfter(source,/:\s*Card\s*=\s*\{/,'{','}');if(!root)return null;const m=/\n\tthirdParty\s*:\s*\{/.exec(root);if(!m)return null;const start=root.indexOf('{',m.index+m[0].length-1);const end=findBalancedEnd(root,start,'{','}');if(end<0)return null;return integerProperty(root.slice(start,end+1),'cardmarket');}catch{return null;}}
function comparableCardName(value){let v=String(value||'').trim().replace(/♀/g,' female ').replace(/♂/g,' male ').replace(/[☆★]/g,' gold star ').replace(/\bGold Star\b/gi,' gold star ').replace(/-EX\b/gi,' EX');v=v.replace(/^M\s+(?=\S+\s+EX\b)/i,'M');return normaliseComparableName(v);}
function comparableProviderName(value){let v=String(value||'').trim().replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female').replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');const suffix=/\s+\[[^[\]]+\]\s*$/;while(suffix.test(v))v=v.replace(suffix,'').trim();v=v.replace(/\s+Lv\.\s*\d+\b/gi,' ').replace(/δ\s+Delta Species\b/gi,'δ').replace(/\[([A-Za-z0-9]+)\]/g,(all,m)=>SP_MARKERS.has(String(m).toUpperCase())?` ${String(m).toUpperCase()} `:all).replace(/\s+/g,' ').trim();return comparableCardName(v);}
function isBaselineVariant(v,type){return v?.type===type&&!v?.subtype&&!v?.foil&&Array.isArray(v?.stamp)&&v.stamp.length===0;}

async function build(db){
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const cardById=new Map();for(const set of repo.sets)for(const card of set.cards)cardById.set(card.tcgdexCardId,card);
  const [{artifact:catalogue,products},{artifact:guide,snapshot}]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
  const productById=new Map(products.map(p=>[String(p.sourceRecordId),p]));
  const priceById=new Map(snapshot.priceGuides.map(p=>[String(p.idProduct),p]));
  const {rows:ids}=await db.query(`SELECT i.id,i.variant_code,p.name,p.collector_number,array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) tcgdex_card_ids FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex' WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN('standard','holo') AND NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id) GROUP BY i.id,i.variant_code,p.name,p.collector_number ORDER BY i.id`);
  const {rows:existing}=await db.query(`SELECT card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const existingSource=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
  const existingCanonical=new Map(existing.map(r=>[key(r.card_identity_id,r.source_variant_key),String(r.source_record_id)]));
  const counts={eligible:ids.length,singleTcgdexLink:0,withRootProductId:0,productExists:0,nameCompatible:0,targetVariantCompatible:0,priceable:0,preBatchSafe:0,safeExactMappings:0,batchConflictKeys:0,batchHeldCandidates:0};
  const reasons={},raw=[];const reason=r=>reasons[r]=(reasons[r]||0)+1;
  for(const i of ids){
    if(!Array.isArray(i.tcgdex_card_ids)||i.tcgdex_card_ids.length!==1){reason('multiple_tcgdex_card_links');continue;}counts.singleTcgdexLink++;
    const tcgdexCardId=i.tcgdex_card_ids[0],card=cardById.get(tcgdexCardId);if(!card){reason('missing_tcgdex_card');continue;}
    const rootId=rootCardmarketId(card);if(!rootId){reason('no_root_cardmarket_product_id');continue;}counts.withRootProductId++;
    const sourceRecordId=String(rootId),product=productById.get(sourceRecordId);if(!product){reason('root_product_absent_from_official_catalogue');continue;}counts.productExists++;
    const canonicalName=comparableCardName(i.name),providerName=comparableProviderName(product.name);if(!canonicalName||canonicalName!==providerName){reason('root_product_name_conflict');continue;}counts.nameCompatible++;
    const targetType=targetTypeFor[i.variant_code],baseline=(card.variants||[]).filter(v=>isBaselineVariant(v,targetType));
    if((card.variants||[]).length>0&&baseline.length===0){reason('no_baseline_target_variant');continue;}
    const explicitBaselineIds=[...new Set(baseline.map(v=>Number(v.cardmarketProductId)).filter(n=>Number.isSafeInteger(n)&&n>0))];
    if(explicitBaselineIds.length>1){reason('multiple_baseline_target_product_ids');continue;}
    if(explicitBaselineIds.length===1&&explicitBaselineIds[0]!==rootId){reason('baseline_target_product_disagrees_with_root');continue;}counts.targetVariantCompatible++;
    const lane=laneFor[i.variant_code],price=priceById.get(sourceRecordId);if(!price||!hasMeaningfulCardmarketLane(price,lane)){reason('no_meaningful_price_lane');continue;}counts.priceable++;
    const sourceVariantKey=sourceVariantFor[i.variant_code],sk=key(sourceRecordId,sourceVariantKey),ck=key(i.id,sourceVariantKey);
    if(existingSource.has(sk)&&existingSource.get(sk)!==i.id){reason('source_owned');continue;}
    if(existingCanonical.has(ck)&&existingCanonical.get(ck)!==sourceRecordId){reason('canonical_owned');continue;}
    raw.push({id:stableId('fdcardmap',[i.id,'cardmarket',sourceRecordId,sourceVariantKey]),cardIdentityId:i.id,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,tcgdexCardId,sourceRecordId,sourceVariantKey,sourceVersion:catalogue.sha256,cardmarketProductName:product.name,proof:{method:'tcgdex_root_cardmarket_product_id_verified_official_catalogue_and_target_finish',tcgdexRevision:process.env.TCGDEX_REVISION||null}});
  }
  counts.preBatchSafe=raw.length;
  const owners=new Map(),bad=new Set();for(const r of raw){const sk=key(r.sourceRecordId,r.sourceVariantKey);if(owners.has(sk)&&owners.get(sk)!==r.cardIdentityId)bad.add(sk);else owners.set(sk,r.cardIdentityId);}
  const candidates=raw.filter(r=>!bad.has(key(r.sourceRecordId,r.sourceVariantKey)));counts.batchConflictKeys=bad.size;counts.batchHeldCandidates=raw.length-candidates.length;counts.safeExactMappings=candidates.length;if(counts.batchHeldCandidates)reason('batch_source_collision');
  const byVariant={};for(const r of candidates)byVariant[r.variantCode]=(byVariant[r.variantCode]||0)+1;
  return{status:'audit_complete',productionWrites:false,source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogue.sha256,cardmarketPriceGuideSha256:guide.sha256},counts,reasons,byVariant,candidates};
}
async function persist(db,report){await db.query('BEGIN');try{for(const r of report.candidates){const s=await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,[r.sourceRecordId,r.sourceVariantKey]);if(s.rows[0]&&s.rows[0].card_identity_id!==r.cardIdentityId)throw new Error(`Source ownership changed for ${r.sourceRecordId}/${r.sourceVariantKey}`);const c=await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2`,[r.cardIdentityId,r.sourceVariantKey]);if(c.rows[0]&&String(c.rows[0].source_record_id)!==r.sourceRecordId)throw new Error(`Canonical ownership changed for ${r.cardIdentityId}/${r.sourceVariantKey}`);const now=Date.now();await db.query(`INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) ON CONFLICT(id) DO NOTHING`,[r.id,r.cardIdentityId,r.sourceRecordId,r.sourceVariantKey,r.sourceVersion,now]);}await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}}
async function main(){validateProductionTarget(process.env.DATABASE_URL);const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2}),db=await pool.connect();let report;try{report=await build(db);if(process.env.MAPPING_WRITE==='true'){await persist(db,report);report={...report,status:'write_complete',productionWrites:true};}}catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}finally{db.release();await pool.end();await writeFile(`${process.env.RUNNER_TEMP||'.'}/cardmarket-tcgdex-root-product-recovery.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,productionWrites:report.productionWrites,counts:report.counts,reasons:report.reasons,byVariant:report.byVariant,samples:report.candidates?.slice(0,20)},null,2));}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();