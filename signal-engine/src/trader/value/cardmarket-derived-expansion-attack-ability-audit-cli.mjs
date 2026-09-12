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
const priceLaneFor=Object.freeze({standard:'standard',holo:'holo'});

function findBalancedEnd(source,start,openChar,closeChar){if(source[start]!==openChar)return-1;let depth=0,quote=null,escaped=false,lineComment=false,blockComment=false;for(let i=start;i<source.length;i++){const c=source[i],n=source[i+1];if(lineComment){if(c==='\n')lineComment=false;continue;}if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++;}continue;}if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote=null;continue;}if(c==='/'&&n==='/'){lineComment=true;i++;continue;}if(c==='/'&&n==='*'){blockComment=true;i++;continue;}if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c===openChar)depth++;else if(c===closeChar){depth--;if(depth===0)return i;}}return-1;}
function balancedAfter(source,regex,openChar,closeChar){const m=regex.exec(source);if(!m)return null;const start=source.indexOf(openChar,m.index+m[0].length-1);if(start<0)return null;const end=findBalancedEnd(source,start,openChar,closeChar);return end<0?null:source.slice(start,end+1);}
function arrayProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\[`),'[',']');}
function objectProperty(source,property){return balancedAfter(source,new RegExp(`\\b${property}\\s*:\\s*\\{`),'{','}');}
function quotedProperty(source,property){if(!source)return null;const m=new RegExp(`\\b${property}\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`).exec(source);return m?m[2].trim():null;}
function topLevelObjects(arraySource){if(!arraySource||arraySource[0]!=='[')return[];const out=[];let i=1;while(i<arraySource.length-1){const open=arraySource.indexOf('{',i);if(open<0)break;const end=findBalancedEnd(arraySource,open,'{','}');if(end<0)break;out.push(arraySource.slice(open,end+1));i=end+1;}return out;}
function namesFromArray(source,property){const block=arrayProperty(source,property);if(!block)return[];return topLevelObjects(block).map(obj=>quotedProperty(objectProperty(obj,'name'),'en')).filter(Boolean);}
function tcgdexDescriptorEvidence(card){try{const source=fs.readFileSync(card.sourcePath,'utf8');return[...new Set([...namesFromArray(source,'attacks'),...namesFromArray(source,'abilities')].map(normaliseComparableName).filter(Boolean))].sort();}catch{return[];}}
function stripProviderDescriptors(name){let value=String(name||'').trim().replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female').replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');const suffix=/\s+\[[^[\]]+\]\s*$/;while(suffix.test(value))value=value.replace(suffix,'').trim();return value;}
function providerDescriptorTerms(name){const groups=[...String(name||'').matchAll(/\[([^\]]+)\]/g)].map(m=>m[1]);const terms=[];for(const g of groups){for(const part of g.split('|')){const v=normaliseComparableName(part);if(v&&!/^\d+[a-z]?$/.test(v))terms.push(v);}}return[...new Set(terms)].sort();}
function sameTermSet(left,right){return left.length>0&&left.length===right.length&&left.every((v,i)=>v===right[i]);}
function expansionId(product){const n=Number(product?.sourceExpansionId);return Number.isSafeInteger(n)&&n>0?n:null;}

async function build(db){
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const tcgdexCards=new Map();for(const set of repo.sets)for(const card of set.cards)tcgdexCards.set(card.tcgdexCardId,card);
  const [{artifact:catalogue,products},{artifact:guide,snapshot}]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
  const productById=new Map(products.map(p=>[String(p.sourceRecordId),p]));
  const priceBy=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));

  const {rows:existing}=await db.query(`SELECT m.card_identity_id,m.source_record_id,m.source_variant_key,i.set_id FROM fatedrop_card_source_mappings m JOIN fatedrop_card_identities i ON i.id=m.card_identity_id WHERE m.source_name='cardmarket' AND m.source_variant_key IN ('normal','holo') AND i.verification_status='verified' AND i.language_code='en'`);
  const existingSource=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
  const existingCanonical=new Map(existing.map(r=>[key(r.card_identity_id,r.source_variant_key),String(r.source_record_id)]));
  const mappedProductsBySet=new Map();for(const r of existing){const ids=mappedProductsBySet.get(r.set_id)||new Set();ids.add(String(r.source_record_id));mappedProductsBySet.set(r.set_id,ids);}
  const derivedExpansionBySet=new Map(),rejectedSets=[];
  for(const [setId,ids] of mappedProductsBySet){const resolved=[...ids].map(id=>productById.get(id));const expansions=new Set(resolved.map(expansionId).filter(Boolean));if(ids.size>=MIN_PROVEN_PRODUCTS&&resolved.every(Boolean)&&expansions.size===1)derivedExpansionBySet.set(setId,{sourceExpansionId:[...expansions][0],mappedProducts:ids.size});else rejectedSets.push({setId,mappedProducts:ids.size,expansions:[...expansions],missingProducts:resolved.filter(x=>!x).length});}

  const {rows:ids}=await db.query(`SELECT DISTINCT ON (i.id) i.id,i.set_id,i.variant_code,p.name,t.source_record_id tcgdex_card_id,s.name set_name FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id JOIN fatedrop_card_sets s ON s.id=i.set_id JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex' WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN ('standard','holo') AND NOT EXISTS (SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id) ORDER BY i.id,t.source_record_id`);
  const byExpansionBase=new Map();for(const p of products){const eid=expansionId(p);if(!eid)continue;const base=normaliseComparableName(stripProviderDescriptors(p.name));if(!base)continue;const k=key(eid,base),a=byExpansionBase.get(k)||[];a.push(p);byExpansionBase.set(k,a);}

  const candidates=[],ambiguous=[],reasons={};
  let inDerivedScope=0,withDescriptors=0,multiProductBase=0,exactDescriptorUnique=0,priceable=0,conflicts=0;
  const reason=(r)=>{reasons[r]=(reasons[r]||0)+1;};
  for(const i of ids){
    const scope=derivedExpansionBySet.get(i.set_id);if(!scope){reason('no_strict_derived_expansion');continue;}inDerivedScope++;
    const card=tcgdexCards.get(i.tcgdex_card_id);if(!card){reason('tcgdex_card_missing');continue;}
    const evidence=tcgdexDescriptorEvidence(card);if(!evidence.length){reason('no_attack_or_ability_evidence');continue;}withDescriptors++;
    const sameBase=byExpansionBase.get(key(scope.sourceExpansionId,normaliseComparableName(i.name)))||[];if(sameBase.length<2){reason('not_multi_product_base_case');continue;}multiProductBase++;
    const matched=sameBase.map(p=>({p,terms:providerDescriptorTerms(p.name)})).filter(x=>sameTermSet(x.terms,evidence));
    if(matched.length===0){reason('no_exact_descriptor_set_match');continue;}
    if(matched.length>1){ambiguous.push({id:i.id,setName:i.set_name,name:i.name,variantCode:i.variant_code,sourceExpansionId:scope.sourceExpansionId,evidence,products:matched.map(x=>({sourceRecordId:String(x.p.sourceRecordId),productName:x.p.name}))});reason('multiple_exact_descriptor_set_matches');continue;}
    exactDescriptorUnique++;
    const p=matched[0].p,sourceRecordId=String(p.sourceRecordId),sourceVariantKey=sourceVariantFor[i.variant_code],lane=priceLaneFor[i.variant_code];
    const priceRow=priceBy.get(sourceRecordId);if(!priceRow||!hasMeaningfulCardmarketLane(priceRow,lane)){reason('no_meaningful_target_price_lane');continue;}priceable++;
    const sk=key(sourceRecordId,sourceVariantKey),ck=key(i.id,sourceVariantKey);if((existingSource.has(sk)&&existingSource.get(sk)!==i.id)||(existingCanonical.has(ck)&&existingCanonical.get(ck)!==sourceRecordId)){conflicts++;reason('ownership_conflict');continue;}
    candidates.push({cardIdentityId:i.id,tcgdexCardId:i.tcgdex_card_id,setId:i.set_id,setName:i.set_name,name:i.name,variantCode:i.variant_code,sourceRecordId,sourceVariantKey,sourceExpansionId:scope.sourceExpansionId,existingMappedProductsInSet:scope.mappedProducts,cardmarketProductName:p.name,evidence,proof:'derived_single_expansion_plus_exact_attack_ability_descriptor_set'});
  }
  return{status:'audit_complete',productionWrites:false,source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogue.sha256,cardmarketPriceGuideSha256:guide.sha256},policy:{minExistingMappedProductsForDerivedExpansion:MIN_PROVEN_PRODUCTS,exactDescriptorSetEquality:true,meaningfulTargetPriceLaneRequired:true},counts:{eligibleUnmappedWithTcgdex:ids.length,setsWithStrictDerivedExpansion:derivedExpansionBySet.size,rejectedSets:rejectedSets.length,inDerivedScope,withDescriptors,multiProductBase,exactDescriptorUnique,priceableUnique:priceable,safeExactMappings:candidates.length,ambiguous:ambiguous.length,conflicts},reasons,candidates,ambiguous,rejectedSets};
}

async function main(){if(process.env.MAPPING_WRITE==='true')throw new Error('Audit is read-only');validateProductionTarget(process.env.DATABASE_URL);const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});const db=await pool.connect();let report;try{report=await build(db);}catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}finally{db.release();await pool.end();await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-derived-expansion-attack-ability-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,counts:report.counts,reasons:report.reasons,candidates:report.candidates?.slice(0,20)},null,2));}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
