import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const countBy=(rows,keyFn)=>{
  const out={};
  for(const row of rows){const k=keyFn(row)||'unknown';out[k]=(out[k]||0)+1;}
  return Object.fromEntries(Object.entries(out).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));
};

async function audit(db){
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:false});
  const {artifact,products}=await fetchCardmarketPokemonSinglesCatalogue();

  const {rows:setRows}=await db.query(`
    SELECT s.id AS set_id,s.name AS set_name,
           t.source_record_id AS tcgdex_set_id,
           cm.source_record_id AS cardmarket_expansion_override
    FROM fatedrop_card_sets s
    LEFT JOIN fatedrop_card_set_source_mappings t
      ON t.set_id=s.id AND t.source_name='tcgdex'
    LEFT JOIN fatedrop_card_set_source_mappings cm
      ON cm.set_id=s.id AND cm.source_name='cardmarket'
    WHERE s.verification_status='verified'`);

  const {rows:ids}=await db.query(`
    SELECT i.id,i.set_id,i.variant_code,p.collector_number,p.name
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
    ORDER BY i.set_id,p.collector_number,i.variant_code`);

  const setMeta=new Map();
  for(const s of setRows){
    const source=s.tcgdex_set_id?repo.bySetId.get(s.tcgdex_set_id):null;
    const override=Number(s.cardmarket_expansion_override);
    const sourceExpansionId=Number(source?.cardmarketExpansionId);
    const expansionId=Number.isSafeInteger(override)&&override>0?override:sourceExpansionId;
    setMeta.set(s.set_id,{
      setId:s.set_id,setName:s.set_name,tcgdexSetId:s.tcgdex_set_id||null,
      expansionId:Number.isSafeInteger(expansionId)&&expansionId>0?expansionId:null,
      tcgdexFound:Boolean(source),
    });
  }

  const byExpansion=new Map();
  for(const product of products){
    const expansionId=Number(product.sourceExpansionId);
    if(!Number.isSafeInteger(expansionId)||expansionId<=0) continue;
    const a=byExpansion.get(expansionId)||[];
    a.push({product,parsed:parseCardmarketSingleProductName(product.name)});
    byExpansion.set(expansionId,a);
  }

  const rows=[];
  for(const i of ids){
    const set=setMeta.get(i.set_id)||{};
    let bucket='unknown';let detail=null;
    if(!set.tcgdexSetId) bucket='missing_tcgdex_set_mapping';
    else if(!set.tcgdexFound) bucket='tcgdex_set_missing_from_pinned_repo';
    else if(!set.expansionId) bucket='missing_cardmarket_expansion_scope';
    else {
      const expansion=byExpansion.get(set.expansionId)||[];
      if(!expansion.length) bucket='cardmarket_expansion_absent_from_catalogue';
      else {
        let collector=null;try{collector=normaliseCollectorNumber(i.collector_number);}catch{}
        if(!collector) bucket='canonical_collector_invalid';
        else {
          const parsable=expansion.filter(x=>x.parsed);
          if(!parsable.length) bucket='expansion_products_unparseable';
          else {
            const exactCollector=parsable.filter(x=>x.parsed.collectorNumber===collector);
            const exactName=parsable.filter(x=>normaliseComparableName(x.parsed.cardName)===normaliseComparableName(i.name));
            const both=exactCollector.filter(x=>normaliseComparableName(x.parsed.cardName)===normaliseComparableName(i.name));
            if(both.length===1){bucket='exact_structured_should_have_matched';detail=both[0].product.sourceRecordId;}
            else if(both.length>1){bucket='multiple_exact_structured_products';detail=both.map(x=>x.product.sourceRecordId);}
            else if(exactCollector.length===1&&exactName.length===0){bucket='collector_exact_name_mismatch_provider_naming_candidate';detail={productId:exactCollector[0].product.sourceRecordId,productName:exactCollector[0].product.name};}
            else if(exactName.length===1&&exactCollector.length===0){bucket='name_exact_collector_mismatch_numbering_candidate';detail={productId:exactName[0].product.sourceRecordId,productName:exactName[0].product.name,sourceCollector:exactName[0].parsed.collectorNumber};}
            else if(exactCollector.length>1){bucket='collector_matches_multiple_products';detail=exactCollector.map(x=>({id:x.product.sourceRecordId,name:x.product.name}));}
            else if(exactName.length>1){bucket='name_matches_multiple_products';detail=exactName.map(x=>({id:x.product.sourceRecordId,name:x.product.name,collector:x.parsed.collectorNumber}));}
            else {
              const rawNameMatches=expansion.filter(x=>normaliseComparableName(x.product.name).startsWith(normaliseComparableName(i.name)));
              bucket=rawNameMatches.length?'unparsed_or_provider_suffix_candidate':'no_name_or_collector_evidence_in_expansion';
              if(rawNameMatches.length) detail=rawNameMatches.slice(0,5).map(x=>({id:x.product.sourceRecordId,name:x.product.name}));
            }
          }
        }
      }
    }
    rows.push({cardIdentityId:i.id,setId:i.set_id,setName:set.setName||null,variantCode:i.variant_code,collectorNumber:i.collector_number,cardName:i.name,bucket,detail});
  }
  const byBucket=countBy(rows,r=>r.bucket),byVariant=countBy(rows,r=>r.variantCode),bySet=countBy(rows,r=>r.setName||r.setId);
  const recoverableBuckets=['collector_exact_name_mismatch_provider_naming_candidate','name_exact_collector_mismatch_numbering_candidate','unparsed_or_provider_suffix_candidate','exact_structured_should_have_matched'];
  const recoverableCandidates=rows.filter(r=>recoverableBuckets.includes(r.bucket));
  return {status:'audit_complete',productionWrites:false,source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:artifact.sha256},counts:{unresolvedNormalHolo:rows.length,recoverableCandidates:recoverableCandidates.length},byBucket,byVariant,topSets:Object.fromEntries(Object.entries(bySet).slice(0,30)),recoverableCandidates,rows};
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});const db=await pool.connect();let report;
  try{report=await audit(db);}catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{db.release();await pool.end();const out=(process.env.RUNNER_TEMP||'.')+'/cardmarket-unresolved-bucket-audit.json';await writeFile(out,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,counts:report.counts,byBucket:report.byBucket},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();