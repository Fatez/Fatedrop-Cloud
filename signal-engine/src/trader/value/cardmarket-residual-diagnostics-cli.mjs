import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const key=(...p)=>p.join('|');
const SP_MARKERS=new Set(['G','GL','FB','C','E4','M']);
function findBalancedEnd(source,start,openChar,closeChar){if(source[start]!==openChar)return-1;let depth=0,quote=null,escaped=false,lineComment=false,blockComment=false;for(let i=start;i<source.length;i++){const c=source[i],n=source[i+1];if(lineComment){if(c==='\n')lineComment=false;continue;}if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++;}continue;}if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote=null;continue;}if(c==='/'&&n==='/'){lineComment=true;i++;continue;}if(c==='/'&&n==='*'){blockComment=true;i++;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c===openChar)depth++;else if(c===closeChar){depth--;if(depth===0)return i;}}return-1;}
function balancedAfter(source,regex,openChar,closeChar){const m=regex.exec(source);if(!m)return null;const start=source.indexOf(openChar,m.index+m[0].length-1);if(start<0)return null;const end=findBalancedEnd(source,start,openChar,closeChar);return end<0?null:source.slice(start,end+1);}
function arrayProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\[`),'[',']');}
function objectProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\{`),'{','}');}
function quotedProperty(source,property){if(!source)return null;const m=new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);return m?m[2].trim():null;}
function topLevelObjects(arraySource){if(!arraySource||arraySource[0]!=='[')return[];const out=[];let i=1;while(i<arraySource.length-1){const open=arraySource.indexOf('{',i);if(open<0)break;const end=findBalancedEnd(arraySource,open,'{','}');if(end<0)break;out.push(arraySource.slice(open,end+1));i=end+1;}return out;}
function namesFromArray(source,property){const block=arrayProperty(source,property);if(!block)return[];return topLevelObjects(block).map(obj=>quotedProperty(objectProperty(obj,'name'),'en')).filter(Boolean);}
function descriptorEvidence(card){try{const source=fs.readFileSync(card.sourcePath,'utf8');return[...new Set([...namesFromArray(source,'attacks'),...namesFromArray(source,'abilities')].map(normaliseComparableName).filter(Boolean))].sort();}catch{return[];}}
function parseProvider(name){let value=String(name||'').trim().replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female').replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');const groups=[],suffix=/\s+\[([^[\]]+)\]\s*$/;while(true){const m=suffix.exec(value);if(!m)break;groups.unshift(m[1]);value=value.slice(0,m.index).trim();}value=value.replace(/\s+Lv\.\s*\d+\b/gi,' ').replace(/δ\s+Delta Species\b/gi,'δ');value=value.replace(/\[([A-Za-z0-9]+)\]/g,(all,marker)=>SP_MARKERS.has(String(marker).toUpperCase())?` ${String(marker).toUpperCase()} `:all).replace(/\s+/g,' ').trim();const terms=[];for(const group of groups){for(const part of group.split('|')){const t=normaliseComparableName(part);if(t&&!/^\d+[a-z]?$/.test(t))terms.push(t);}}return{base:normaliseComparableName(value),terms:[...new Set(terms)].sort()};}
function sameSet(a,b){return a.length>0&&a.length===b.length&&a.every((v,i)=>v===b[i]);}
function tokens(s){return new Set(normaliseComparableName(s).split(/\s+/).filter(Boolean));}
function overlap(a,b){const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return n/new Set([...A,...B]).size;}

async function main(){
  if(process.env.MAPPING_WRITE==='true')throw new Error('Diagnostic is read-only');
  validateProductionTarget(process.env.DATABASE_URL);
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const cardById=new Map();for(const set of repo.sets)for(const card of set.cards)cardById.set(card.tcgdexCardId,card);
  const {products}=await fetchCardmarketPokemonSinglesCatalogue();
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2}),db=await pool.connect();
  let report;
  try{
    const {rows:sets}=await db.query(`SELECT s.id set_id,s.name set_name,t.source_record_id tcgdex_set_id,cm.source_record_id cm_override FROM fatedrop_card_sets s JOIN fatedrop_card_set_source_mappings t ON t.set_id=s.id AND t.source_name='tcgdex' LEFT JOIN fatedrop_card_set_source_mappings cm ON cm.set_id=s.id AND cm.source_name='cardmarket' WHERE s.verification_status='verified'`);
    const expansionBySet=new Map();for(const s of sets){const ev=repo.bySetId.get(s.tcgdex_set_id),override=Number(s.cm_override),sourceId=Number(ev?.cardmarketExpansionId),id=Number.isSafeInteger(override)&&override>0?override:sourceId;if(Number.isSafeInteger(id)&&id>0)expansionBySet.set(s.set_id,{id,name:s.set_name});}
    const {rows:ids}=await db.query(`SELECT i.id,i.set_id,i.variant_code,p.name,p.collector_number,array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) tcgdex_card_ids FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex' WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN('standard','holo') AND NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id) GROUP BY i.id,i.set_id,i.variant_code,p.name,p.collector_number ORDER BY i.id`);
    const byExpansion=new Map();for(const p of products){const eid=Number(p.sourceExpansionId);if(!Number.isSafeInteger(eid)||eid<=0)continue;const parsed=parseProvider(p.name);const arr=byExpansion.get(eid)||[];arr.push({p,parsed});byExpansion.set(eid,arr);}
    const reasons={};const samples={no_legacy_base_match:[],no_exact_descriptor_match:[],multiple_exact_descriptor_matches:[],no_descriptor_evidence:[],no_explicit_expansion:[]};const bump=r=>reasons[r]=(reasons[r]||0)+1;
    for(const i of ids){
      if(!Array.isArray(i.tcgdex_card_ids)||i.tcgdex_card_ids.length!==1){bump('multiple_tcgdex_card_links');continue;}
      const tcgdexCardId=i.tcgdex_card_ids[0],card=cardById.get(tcgdexCardId),scope=expansionBySet.get(i.set_id);
      if(!scope){bump('no_explicit_expansion');if(samples.no_explicit_expansion.length<80)samples.no_explicit_expansion.push({id:i.id,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,tcgdexCardId,tcgdexVariants:card?.variants||[]});continue;}
      const evidence=card?descriptorEvidence(card):[];
      const expansionRows=byExpansion.get(scope.id)||[],base=normaliseComparableName(i.name),sameBase=expansionRows.filter(x=>x.parsed.base===base);
      if(!evidence.length){bump('no_descriptor_evidence');if(samples.no_descriptor_evidence.length<120)samples.no_descriptor_evidence.push({id:i.id,setName:scope.name,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,tcgdexCardId,tcgdexVariants:card?.variants||[],exactBaseProducts:sameBase.slice(0,12).map(x=>({id:String(x.p.sourceRecordId),name:x.p.name,metacardId:x.p.sourceMetacardId,dateAdded:x.p.sourceDateAdded}))});continue;}
      if(!sameBase.length){bump('no_legacy_base_match');if(samples.no_legacy_base_match.length<120){const near=expansionRows.map(x=>({score:overlap(i.name,x.p.name),id:String(x.p.sourceRecordId),name:x.p.name,base:x.parsed.base,terms:x.parsed.terms})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,8);samples.no_legacy_base_match.push({id:i.id,setName:scope.name,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,evidence,tcgdexCardId,tcgdexVariants:card?.variants||[],near});}continue;}
      const exact=sameBase.filter(x=>sameSet(x.parsed.terms,evidence));
      if(exact.length===0){bump('no_exact_descriptor_match');if(samples.no_exact_descriptor_match.length<160)samples.no_exact_descriptor_match.push({id:i.id,setName:scope.name,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,evidence,tcgdexCardId,tcgdexVariants:card?.variants||[],products:sameBase.slice(0,16).map(x=>({id:String(x.p.sourceRecordId),name:x.p.name,terms:x.parsed.terms,metacardId:x.p.sourceMetacardId,dateAdded:x.p.sourceDateAdded}))});continue;}
      if(exact.length>1){bump('multiple_exact_descriptor_matches');if(samples.multiple_exact_descriptor_matches.length<180)samples.multiple_exact_descriptor_matches.push({id:i.id,setName:scope.name,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,evidence,tcgdexCardId,tcgdexVariants:card?.variants||[],products:exact.slice(0,20).map(x=>({id:String(x.p.sourceRecordId),name:x.p.name,metacardId:x.p.sourceMetacardId,dateAdded:x.p.sourceDateAdded}))});continue;}
      bump('unique_exact_descriptor_match');
    }
    report={status:'audit_complete',productionWrites:false,eligible:ids.length,reasons,samples};
  }catch(error){report={status:'blocked',productionWrites:false,error:error instanceof Error?error.message:String(error)};process.exitCode=1;}
  finally{db.release();await pool.end();await writeFile(`${process.env.RUNNER_TEMP||'.'}/cardmarket-residual-diagnostics.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,eligible:report.eligible,reasons:report.reasons,sampleCounts:Object.fromEntries(Object.entries(report.samples||{}).map(([k,v])=>[k,v.length]))},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();