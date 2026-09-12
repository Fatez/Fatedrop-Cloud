import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const MIN_PROVEN_PRODUCTS=5;
const key=(...parts)=>parts.join('|');
const sourceVariantFor=Object.freeze({standard:'normal',holo:'holo'});
const laneFor=Object.freeze({standard:'standard',holo:'holo'});
const SP_MARKERS=new Set(['G','GL','FB','C','E4','M']);

function findBalancedEnd(source,start,openChar,closeChar){if(source[start]!==openChar)return-1;let depth=0,quote=null,escaped=false,lineComment=false,blockComment=false;for(let i=start;i<source.length;i++){const c=source[i],n=source[i+1];if(lineComment){if(c==='\n')lineComment=false;continue;}if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++;}continue;}if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote=null;continue;}if(c==='/'&&n==='/'){lineComment=true;i++;continue;}if(c==='/'&&n==='*'){blockComment=true;i++;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c===openChar)depth++;else if(c===closeChar){depth--;if(depth===0)return i;}}return-1;}
function balancedAfter(source,regex,openChar,closeChar){const m=regex.exec(source);if(!m)return null;const start=source.indexOf(openChar,m.index+m[0].length-1);if(start<0)return null;const end=findBalancedEnd(source,start,openChar,closeChar);return end<0?null:source.slice(start,end+1);}
function arrayProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\[`),'[',']');}
function objectProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\{`),'{','}');}
function quotedProperty(source,property){if(!source)return null;const m=new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);return m?m[2].trim():null;}
function topLevelObjects(arraySource){if(!arraySource||arraySource[0]!=='[')return[];const out=[];let i=1;while(i<arraySource.length-1){const open=arraySource.indexOf('{',i);if(open<0)break;const end=findBalancedEnd(arraySource,open,'{','}');if(end<0)break;out.push(arraySource.slice(open,end+1));i=end+1;}return out;}
function namesFromArray(source,property){const block=arrayProperty(source,property);if(!block)return[];return topLevelObjects(block).map(obj=>quotedProperty(objectProperty(obj,'name'),'en')).filter(Boolean);}
function descriptorEvidence(card){try{const source=fs.readFileSync(card.sourcePath,'utf8');return[...new Set([...namesFromArray(source,'attacks'),...namesFromArray(source,'abilities')].map(normaliseComparableName).filter(Boolean))].sort();}catch{return[];}}
function parseProvider(name){
  let value=String(name||'').trim().replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female').replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');
  const groups=[],suffix=/\s+\[([^[]]+)\]\s*$/;
  while(true){const m=suffix.exec(value);if(!m)break;groups.unshift(m[1]);value=value.slice(0,m.index).trim();}
  value=value.replace(/\s+Lv\.\s*\d+\b/gi,' ').replace(/δ\s+Delta Species\b/gi,'δ');
  value=value.replace(/\[([A-Za-z0-9]+)\]/g,(all,marker)=>SP_MARKERS.has(String(marker).toUpperCase())?` ${String(marker).toUpperCase()} `:all).replace(/\s+/g,' ').trim();
  const terms=[];for(const group of groups){for(const part of group.split('|')){const t=normaliseComparableName(part);if(t&&!/^\d+[a-z]?$/.test(t))terms.push(t);}}
  return{base:normaliseComparableName(value),terms:[...new Set(terms)].sort()};
}
function sameSet(a,b){return a.length>0&&a.length===b.length&&a.every((v,i)=>v===b[i]);}
function expansionId(p){const n=Number(p?.sourceExpansionId);return Number.isSafeInteger(n)&&n>0?n:null;}

async function main(){
  if(process.env.MAPPING_WRITE==='true')throw new Error('Audit is read-only');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2}),db=await pool.connect();let report;
  try{
    const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
    const cardById=new Map();for(const set of repo.sets)for(const card of set.cards)cardById.set(card.tcgdexCardId,card);
    const [{products},{snapshot}]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
    const productById=new Map(products.map(p=>[String(p.sourceRecordId),p])),priceBy=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));

    const {rows:setRows}=await db.query(`SELECT s.id set_id,s.name set_name,t.source_record_id tcgdex_set_id,cm.source_record_id cm_override FROM fatedrop_card_sets s JOIN fatedrop_card_set_source_mappings t ON t.set_id=s.id AND t.source_name='tcgdex' LEFT JOIN fatedrop_card_set_source_mappings cm ON cm.set_id=s.id AND cm.source_name='cardmarket' WHERE s.verification_status='verified'`);
    const explicitSets=new Set();
    for(const s of setRows){const ev=repo.bySetId.get(s.tcgdex_set_id),o=Number(s.cm_override),e=Number(ev?.cardmarketExpansionId),x=Number.isSafeInteger(o)&&o>0?o:e;if(Number.isSafeInteger(x)&&x>0)explicitSets.add(s.set_id);}

    const {rows:existing}=await db.query(`SELECT m.card_identity_id,m.source_record_id,m.source_variant_key,i.set_id FROM fatedrop_card_source_mappings m JOIN fatedrop_card_identities i ON i.id=m.card_identity_id WHERE m.source_name='cardmarket' AND m.source_variant_key IN('normal','holo') AND i.verification_status='verified' AND i.language_code='en'`);
    const sourceOwners=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
    const bySet=new Map();for(const r of existing){const s=bySet.get(r.set_id)||new Set();s.add(String(r.source_record_id));bySet.set(r.set_id,s);}
    const derived=new Map();
    for(const [setId,ids] of bySet){if(explicitSets.has(setId)||ids.size<MIN_PROVEN_PRODUCTS)continue;const rows=[...ids].map(id=>productById.get(id));if(!rows.every(Boolean))continue;const expansions=new Set(rows.map(expansionId).filter(Boolean));if(expansions.size===1)derived.set(setId,{expansionId:[...expansions][0],mappedProducts:ids.size});}

    const {rows:ids}=await db.query(`SELECT i.id,i.set_id,i.variant_code,p.name,p.collector_number,s.name set_name,array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) tcgdex_card_ids FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id JOIN fatedrop_card_sets s ON s.id=i.set_id JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex' WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN('standard','holo') AND NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id) GROUP BY i.id,i.set_id,i.variant_code,p.name,p.collector_number,s.name ORDER BY i.id`);
    const byExpansionBase=new Map();for(const p of products){const e=expansionId(p),parsed=parseProvider(p.name);if(!e||!parsed.base)continue;const k=key(e,parsed.base),a=byExpansionBase.get(k)||[];a.push({p,parsed});byExpansionBase.set(k,a);}

    const counts={eligible:ids.length,withoutExplicitExpansion:0,inStrictDerivedScope:0,withDescriptors:0,baseMatches:0,uniqueDescriptorMatch:0,priceable:0,preBatchSafe:0,safeExactMappings:0,ambiguous:0,existingConflicts:0,batchConflictKeys:0};
    const reasons={},raw=[];const reason=r=>reasons[r]=(reasons[r]||0)+1;
    for(const i of ids){
      if(explicitSets.has(i.set_id)){reason('has_explicit_expansion');continue;}counts.withoutExplicitExpansion++;
      const scope=derived.get(i.set_id);if(!scope){reason('no_strict_derived_expansion');continue;}counts.inStrictDerivedScope++;
      if(!Array.isArray(i.tcgdex_card_ids)||i.tcgdex_card_ids.length!==1){reason('multiple_tcgdex_links');continue;}
      const card=cardById.get(i.tcgdex_card_ids[0]);if(!card){reason('missing_card_evidence');continue;}
      const evidence=descriptorEvidence(card);if(!evidence.length){reason('no_descriptor_evidence');continue;}counts.withDescriptors++;
      const matches=byExpansionBase.get(key(scope.expansionId,normaliseComparableName(i.name)))||[];if(!matches.length){reason('no_legacy_base_match');continue;}counts.baseMatches++;
      const exact=matches.filter(x=>sameSet(x.parsed.terms,evidence));if(exact.length!==1){if(exact.length>1){counts.ambiguous++;reason('multiple_exact_descriptor_matches');}else reason('no_exact_descriptor_match');continue;}counts.uniqueDescriptorMatch++;
      const product=exact[0].p,sourceRecordId=String(product.sourceRecordId),sv=sourceVariantFor[i.variant_code],lane=laneFor[i.variant_code],price=priceBy.get(sourceRecordId);if(!price||!hasMeaningfulCardmarketLane(price,lane)){reason('no_meaningful_price_lane');continue;}counts.priceable++;
      const sk=key(sourceRecordId,sv);if(sourceOwners.has(sk)&&sourceOwners.get(sk)!==i.id){counts.existingConflicts++;reason('source_owned');continue;}
      raw.push({identityId:i.id,setId:i.set_id,setName:i.set_name,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,tcgdexCardId:i.tcgdex_card_ids[0],sourceRecordId,sourceVariantKey:sv,derivedExpansionId:scope.expansionId,existingMappedProductsInSet:scope.mappedProducts,cardmarketProductName:product.name,evidence});
    }
    counts.preBatchSafe=raw.length;const seen=new Map(),bad=new Set();for(const r of raw){const k=key(r.sourceRecordId,r.sourceVariantKey);if(seen.has(k)&&seen.get(k)!==r.identityId)bad.add(k);else seen.set(k,r.identityId);}const candidates=raw.filter(r=>!bad.has(key(r.sourceRecordId,r.sourceVariantKey)));counts.batchConflictKeys=bad.size;counts.safeExactMappings=candidates.length;const byCandidateSet={};for(const r of candidates)byCandidateSet[r.setName]=(byCandidateSet[r.setName]||0)+1;
    report={status:'audit_complete',productionWrites:false,policy:{minProvenProducts:MIN_PROVEN_PRODUCTS,unanimousDerivedExpansion:true,exactDescriptorSet:true},counts,reasons,bySet:byCandidateSet,candidates};
  }catch(error){report={status:'blocked',productionWrites:false,error:error instanceof Error?error.message:String(error)};process.exitCode=1;}
  finally{db.release();await pool.end();await writeFile(`${process.env.RUNNER_TEMP||'.'}/cardmarket-derived-legacy-audit.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,counts:report.counts,reasons:report.reasons,bySet:report.bySet},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
