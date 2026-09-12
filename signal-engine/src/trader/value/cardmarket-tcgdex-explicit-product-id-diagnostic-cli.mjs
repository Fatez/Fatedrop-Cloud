import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const laneFor=Object.freeze({standard:'standard',holo:'holo'});

async function main(){
  if(process.env.MAPPING_WRITE==='true')throw new Error('Diagnostic is read-only');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});const db=await pool.connect();let report;
  try{
    const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
    const cards=new Map();for(const set of repo.sets)for(const card of set.cards)cards.set(card.tcgdexCardId,card);
    const [{artifact:catalogue,products},{artifact:guide,snapshot}]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
    const productById=new Map(products.map(p=>[String(p.sourceRecordId),p]));
    const priceById=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));
    const {rows}=await db.query(`SELECT DISTINCT ON(i.id) i.id,i.variant_code,i.set_id,p.name,p.collector_number,s.name set_name,t.source_record_id tcgdex_card_id FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id JOIN fatedrop_card_sets s ON s.id=i.set_id JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex' WHERE i.verification_status='verified' AND i.language_code='en' AND i.variant_code IN ('standard','holo') AND NOT EXISTS(SELECT 1 FROM fatedrop_card_source_mappings m WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id) ORDER BY i.id,t.source_record_id`);
    const counts={eligibleUnmappedWithTcgdex:rows.length,cardsWithAnyExplicitProductId:0,identitiesWithOneDistinctExplicitProductId:0,identitiesWithMultipleDistinctExplicitProductIds:0,oneIdExistsInOfficialCatalogue:0,oneIdWithMeaningfulTargetPriceLane:0};
    const variantShapes={},oneIdSamples=[],multiIdSamples=[],missingIdSamples=[];
    for(const row of rows){
      const card=cards.get(row.tcgdex_card_id);if(!card)continue;
      const explicit=card.variants.filter(v=>Number.isSafeInteger(Number(v.cardmarketProductId))&&Number(v.cardmarketProductId)>0);
      if(!explicit.length)continue;counts.cardsWithAnyExplicitProductId++;
      for(const v of explicit){const shape=JSON.stringify({type:v.type||null,subtype:v.subtype||null,foil:v.foil||null,stamp:v.stamp||[]});variantShapes[shape]=(variantShapes[shape]||0)+1;}
      const ids=[...new Set(explicit.map(v=>String(v.cardmarketProductId)))];
      if(ids.length===1){
        counts.identitiesWithOneDistinctExplicitProductId++;
        const id=ids[0],product=productById.get(id)||null;
        if(product)counts.oneIdExistsInOfficialCatalogue++;
        const price=priceById.get(id),lane=laneFor[row.variant_code];
        const priceable=Boolean(product&&price&&hasMeaningfulCardmarketLane(price,lane));if(priceable)counts.oneIdWithMeaningfulTargetPriceLane++;
        if(oneIdSamples.length<250)oneIdSamples.push({identityId:row.id,setName:row.set_name,cardName:row.name,collectorNumber:row.collector_number,variantCode:row.variant_code,tcgdexCardId:row.tcgdex_card_id,sourceRecordId:id,cardmarketProductName:product?.name||null,sourceExpansionId:product?.sourceExpansionId||null,priceableTargetLane:priceable,tcgdexVariants:explicit});
        if(!product&&missingIdSamples.length<100)missingIdSamples.push({identityId:row.id,setName:row.set_name,cardName:row.name,variantCode:row.variant_code,tcgdexCardId:row.tcgdex_card_id,sourceRecordId:id,tcgdexVariants:explicit});
      }else{
        counts.identitiesWithMultipleDistinctExplicitProductIds++;
        if(multiIdSamples.length<250)multiIdSamples.push({identityId:row.id,setName:row.set_name,cardName:row.name,collectorNumber:row.collector_number,variantCode:row.variant_code,tcgdexCardId:row.tcgdex_card_id,productIds:ids,products:ids.map(id=>({sourceRecordId:id,productName:productById.get(id)?.name||null,sourceExpansionId:productById.get(id)?.sourceExpansionId||null})),tcgdexVariants:explicit});
      }
    }
    report={status:'complete',productionWrites:false,source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogue.sha256,cardmarketPriceGuideSha256:guide.sha256},counts,variantShapes,oneIdSamples,multiIdSamples,missingIdSamples};
  }catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{db.release();await pool.end();await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-tcgdex-explicit-product-id-diagnostic.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,counts:report.counts,variantShapes:report.variantShapes,oneIdSamples:report.oneIdSamples?.slice(0,15),multiIdSamples:report.multiIdSamples?.slice(0,15)},null,2));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
