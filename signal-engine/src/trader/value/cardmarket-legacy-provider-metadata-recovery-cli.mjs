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
const stableId=(prefix,parts)=>`${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24)}`;
const sourceVariantFor=Object.freeze({standard:'normal',holo:'holo'});
const laneFor=Object.freeze({standard:'standard',holo:'holo'});
const SP_MARKERS=new Set(['G','GL','FB','C','E4','M']);

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
function descriptorEvidence(card){try{const source=fs.readFileSync(card.sourcePath,'utf8');return [...new Set([...namesFromArray(source,'attacks'),...namesFromArray(source,'abilities')].map(normaliseComparableName).filter(Boolean))].sort();}catch{return[];}}
function parseProvider(name){
  let value=String(name||'').trim().replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female').replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');
  const groups=[],suffix=/\s+\[([^[\]]+)\]\s*$/;
  while(true){const m=suffix.exec(value);if(!m)break;groups.unshift(m[1]);value=value.slice(0,m.index).trim();}
  value=value.replace(/\s+Lv\.\s*\d+\b/gi,' ').replace(/δ\s+Delta Species\b/gi,'δ');
  value=value.replace(/\[([A-Za-z0-9]+)\]/g,(all,marker)=>SP_MARKERS.has(String(marker).toUpperCase())?` ${String(marker).toUpperCase()} `:all).replace(/\s+/g,' ').trim();
  const terms=[];for(const group of groups){for(const part of group.split('|')){const t=normaliseComparableName(part);if(t&&!/^\d+[a-z]?$/.test(t))terms.push(t);}}
  return {base:normaliseComparableName(value),terms:[...new Set(terms)].sort()};
}
function sameSet(a,b){return a.length>0&&a.length===b.length&&a.every((v,i)=>v===b[i]);}

export async function build(db, { repoEvidence, sources } = {}) {
  const repo = repoEvidence || loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const cardById=new Map();for(const set of repo.sets)for(const card of set.cards)cardById.set(card.tcgdexCardId,card);
  const [{artifact:catalogue,products},{artifact:guide,snapshot}]=await Promise.all([(sources?.catalogue ?? fetchCardmarketPokemonSinglesCatalogue()),(sources?.guide ?? fetchCardmarketPokemonPriceGuide())]);
  const priceBy=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));

  const {rows:sets}=await db.query(`SELECT s.id set_id,s.name set_name,t.source_record_id tcgdex_set_id,cm.source_record_id cm_override
    FROM fatedrop_card_sets s
    JOIN fatedrop_card_set_source_mappings t ON t.set_id=s.id AND t.source_name='tcgdex'
    LEFT JOIN fatedrop_card_set_source_mappings cm ON cm.set_id=s.id AND cm.source_name='cardmarket'
    WHERE s.verification_status='verified'`);
  const expansionBySet=new Map();
  for(const s of sets){
    const ev=repo.bySetId.get(s.tcgdex_set_id),override=Number(s.cm_override),sourceId=Number(ev?.cardmarketExpansionId);
    const expansionId=Number.isSafeInteger(override)&&override>0?override:sourceId;
    if(Number.isSafeInteger(expansionId)&&expansionId>0)expansionBySet.set(s.set_id,{id:expansionId,name:s.set_name});
  }

  const {rows:ids}=await db.query(`SELECT i.id,i.set_id,i.variant_code,p.name,p.collector_number,
           array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN('standard','holo')
      AND NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id)
    GROUP BY i.id,i.set_id,i.variant_code,p.name,p.collector_number
    ORDER BY i.id`);

  const byExpansion=new Map();
  for(const p of products){
    const expansionId=Number(p.sourceExpansionId);if(!Number.isSafeInteger(expansionId)||expansionId<=0)continue;
    const parsed=parseProvider(p.name);if(!parsed.base)continue;
    const k=key(expansionId,parsed.base),arr=byExpansion.get(k)||[];arr.push({p,parsed});byExpansion.set(k,arr);
  }

  const {rows:existing}=await db.query(`SELECT card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);
  const existingSource=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
  const existingCanonical=new Map(existing.map(r=>[key(r.card_identity_id,r.source_variant_key),String(r.source_record_id)]));

  const counts={eligible:ids.length,singleTcgdexLink:0,withExpansion:0,withDescriptorEvidence:0,baseMatches:0,exactDescriptorUnique:0,priceable:0,preBatchSafe:0,safeExactMappings:0,ambiguous:0,existingConflicts:0,batchSourceConflictKeys:0,batchHeldCandidates:0};
  const reasons={},raw=[];const reason=r=>reasons[r]=(reasons[r]||0)+1;

  for(const i of ids){
    if(!Array.isArray(i.tcgdex_card_ids)||i.tcgdex_card_ids.length!==1){reason('multiple_tcgdex_card_links');continue;}
    counts.singleTcgdexLink++;
    const scope=expansionBySet.get(i.set_id);if(!scope){reason('no_explicit_expansion');continue;}counts.withExpansion++;
    const tcgdexCardId=i.tcgdex_card_ids[0],card=cardById.get(tcgdexCardId);if(!card){reason('missing_card_evidence');continue;}
    const evidence=descriptorEvidence(card);if(!evidence.length){reason('no_descriptor_evidence');continue;}counts.withDescriptorEvidence++;
    const matches=byExpansion.get(key(scope.id,normaliseComparableName(i.name)))||[];if(!matches.length){reason('no_legacy_base_match');continue;}counts.baseMatches++;
    const exact=matches.filter(x=>sameSet(x.parsed.terms,evidence));
    if(exact.length!==1){if(exact.length>1){counts.ambiguous++;reason('multiple_exact_descriptor_matches');}else reason('no_exact_descriptor_match');continue;}
    counts.exactDescriptorUnique++;
    const x=exact[0],sourceRecordId=String(x.p.sourceRecordId),sourceVariantKey=sourceVariantFor[i.variant_code],lane=laneFor[i.variant_code],price=priceBy.get(sourceRecordId);
    if(!price||!hasMeaningfulCardmarketLane(price,lane)){reason('no_meaningful_price_lane');continue;}counts.priceable++;
    const sk=key(sourceRecordId,sourceVariantKey),ck=key(i.id,sourceVariantKey);
    if(existingSource.has(sk)&&existingSource.get(sk)!==i.id){counts.existingConflicts++;reason('source_owned');continue;}
    if(existingCanonical.has(ck)&&existingCanonical.get(ck)!==sourceRecordId){counts.existingConflicts++;reason('canonical_owned');continue;}
    raw.push({
      id:stableId('fdcardmap',[i.id,'cardmarket',sourceRecordId,sourceVariantKey]),
      cardIdentityId:i.id,setName:scope.name,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,tcgdexCardId,
      sourceRecordId,sourceVariantKey,sourceVersion:catalogue.sha256,cardmarketProductName:x.p.name,evidence,providerTerms:x.parsed.terms,
      proof:{method:'explicit_expansion_legacy_provider_metadata_exact_descriptor_set',tcgdexRevision:process.env.TCGDEX_REVISION||null}
    });
  }
  counts.preBatchSafe=raw.length;

  const owners=new Map(),bad=new Set();
  for(const r of raw){const sk=key(r.sourceRecordId,r.sourceVariantKey);if(owners.has(sk)&&owners.get(sk)!==r.cardIdentityId)bad.add(sk);else owners.set(sk,r.cardIdentityId);}
  const candidates=raw.filter(r=>!bad.has(key(r.sourceRecordId,r.sourceVariantKey)));
  counts.batchSourceConflictKeys=bad.size;counts.batchHeldCandidates=raw.length-candidates.length;counts.safeExactMappings=candidates.length;
  if(counts.batchHeldCandidates)reason('batch_source_collision');

  const bySet={},byVariant={};for(const r of candidates){bySet[r.setName]=(bySet[r.setName]||0)+1;byVariant[r.variantCode]=(byVariant[r.variantCode]||0)+1;}
  return {status:'audit_complete',productionWrites:false,source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogue.sha256,cardmarketPriceGuideSha256:guide.sha256},counts,reasons,bySet,byVariant,candidates};
}

async function persist(db,report){
  await db.query('BEGIN');
  try{
    for(const r of report.candidates){
      const source=await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,[r.sourceRecordId,r.sourceVariantKey]);
      if(source.rows[0]&&source.rows[0].card_identity_id!==r.cardIdentityId)throw new Error(`Cardmarket source ownership changed for ${r.sourceRecordId}/${r.sourceVariantKey}`);
      const canonical=await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2`,[r.cardIdentityId,r.sourceVariantKey]);
      if(canonical.rows[0]&&String(canonical.rows[0].source_record_id)!==r.sourceRecordId)throw new Error(`Canonical Cardmarket mapping changed for ${r.cardIdentityId}/${r.sourceVariantKey}`);
      const observedAt=Date.now();
      await db.query(`INSERT INTO fatedrop_card_source_mappings(id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at)
        VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) ON CONFLICT(id) DO NOTHING`,[r.id,r.cardIdentityId,r.sourceRecordId,r.sourceVariantKey,r.sourceVersion,observedAt]);
    }
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2}),db=await pool.connect();let report;
  try{
    report=await build(db);
    if(process.env.MAPPING_WRITE==='true'){await persist(db,report);report={...report,status:'write_complete',productionWrites:true};}
  }catch(error){report={status:'blocked',productionWrites:false,error:error instanceof Error?error.message:String(error)};process.exitCode=1;}
  finally{
    db.release();await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP||'.'}/cardmarket-legacy-provider-metadata-recovery.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:report.status,productionWrites:report.productionWrites,counts:report.counts,reasons:report.reasons,byVariant:report.byVariant,bySet:report.bySet},null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
