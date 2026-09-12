import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const key=(...parts)=>parts.join('|');
const sourceVariantFor=Object.freeze({standard:'normal',holo:'holo'});
const laneFor=Object.freeze({standard:'standard',holo:'holo'});
const SP_MARKERS=new Set(['G','GL','FB','C','E4','M']);

function strictLegacyBase(name){
  let value=String(name||'').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male')
    .replace(/\s+Lv\.\s*\d+\b/gi,' ')
    .replace(/δ\s+Delta Species\b/gi,'δ');
  value=value.replace(/\[([A-Za-z0-9]+)\]/g,(all,marker)=>SP_MARKERS.has(String(marker).toUpperCase())?` ${String(marker).toUpperCase()} `:all);
  return normaliseComparableName(value.replace(/\s+/g,' ').trim());
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2}),db=await pool.connect();let report;
  try{
    const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:false});
    const [{products},{snapshot}]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
    const priceBy=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));
    const {rows:sets}=await db.query(`SELECT s.id set_id,s.name set_name,t.source_record_id tcgdex_set_id,cm.source_record_id cm_override FROM fatedrop_card_sets s JOIN fatedrop_card_set_source_mappings t ON t.set_id=s.id AND t.source_name='tcgdex' LEFT JOIN fatedrop_card_set_source_mappings cm ON cm.set_id=s.id AND cm.source_name='cardmarket' WHERE s.verification_status='verified'`);
    const expansionBySet=new Map();
    for(const s of sets){const ev=repo.bySetId.get(s.tcgdex_set_id),o=Number(s.cm_override),e=Number(ev?.cardmarketExpansionId),x=Number.isSafeInteger(o)&&o>0?o:e;if(Number.isSafeInteger(x)&&x>0)expansionBySet.set(s.set_id,{id:x,name:s.set_name});}
    const {rows:ids}=await db.query(`SELECT i.id,i.set_id,i.variant_code,p.name,p.collector_number,array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) tcgdex_card_ids FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex' WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN('standard','holo') AND NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id) GROUP BY i.id,i.set_id,i.variant_code,p.name,p.collector_number ORDER BY i.id`);
    const byExpansionBase=new Map();
    for(const p of products){const e=Number(p.sourceExpansionId),base=strictLegacyBase(p.name);if(!Number.isSafeInteger(e)||e<=0||!base)continue;const k=key(e,base),a=byExpansionBase.get(k)||[];a.push(p);byExpansionBase.set(k,a);}
    const {rows:existing}=await db.query(`SELECT card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'`);const sourceOwners=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
    const counts={eligible:ids.length,singleTcgdexLink:0,withExpansion:0,uniqueExactBaseProduct:0,priceable:0,preBatchSafe:0,safeExactMappings:0,ambiguousBase:0,existingConflicts:0,batchConflictKeys:0};const reasons={},raw=[];const reason=r=>reasons[r]=(reasons[r]||0)+1;
    for(const i of ids){if(!Array.isArray(i.tcgdex_card_ids)||i.tcgdex_card_ids.length!==1){reason('multiple_tcgdex_links');continue;}counts.singleTcgdexLink++;const scope=expansionBySet.get(i.set_id);if(!scope){reason('no_explicit_expansion');continue;}counts.withExpansion++;const matches=byExpansionBase.get(key(scope.id,normaliseComparableName(i.name)))||[];if(matches.length!==1){if(matches.length>1){counts.ambiguousBase++;reason('multiple_exact_base_products');}else reason('no_exact_base_product');continue;}counts.uniqueExactBaseProduct++;const product=matches[0],sourceRecordId=String(product.sourceRecordId),sv=sourceVariantFor[i.variant_code],lane=laneFor[i.variant_code],price=priceBy.get(sourceRecordId);if(!price||!hasMeaningfulCardmarketLane(price,lane)){reason('no_meaningful_price_lane');continue;}counts.priceable++;const sk=key(sourceRecordId,sv);if(sourceOwners.has(sk)&&sourceOwners.get(sk)!==i.id){counts.existingConflicts++;reason('source_owned');continue;}raw.push({identityId:i.id,setName:scope.name,name:i.name,collectorNumber:i.collector_number,variantCode:i.variant_code,sourceRecordId,sourceVariantKey:sv,cardmarketProductName:product.name});}
    counts.preBatchSafe=raw.length;const seen=new Map(),bad=new Set();for(const r of raw){const k=key(r.sourceRecordId,r.sourceVariantKey);if(seen.has(k)&&seen.get(k)!==r.identityId)bad.add(k);else seen.set(k,r.identityId);}const candidates=raw.filter(r=>!bad.has(key(r.sourceRecordId,r.sourceVariantKey)));counts.batchConflictKeys=bad.size;counts.safeExactMappings=candidates.length;const bySet={},byVariant={};for(const r of candidates){bySet[r.setName]=(bySet[r.setName]||0)+1;byVariant[r.variantCode]=(byVariant[r.variantCode]||0)+1;}report={status:'audit_complete',productionWrites:false,counts,reasons,bySet,byVariant,candidates};
  }catch(error){report={status:'blocked',productionWrites:false,error:error instanceof Error?error.message:String(error)};process.exitCode=1;}
  finally{db.release();await pool.end();await writeFile(`${process.env.RUNNER_TEMP||'.'}/cardmarket-legacy-unique-base-audit.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,counts:report.counts,reasons:report.reasons,byVariant:report.byVariant,bySet:report.bySet},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
