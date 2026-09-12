import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

const SOURCE_VARIANT=Object.freeze({standard:'normal',holo:'holo'});
const PRICE_LANE=Object.freeze({standard:'standard',holo:'holo'});
const TARGET_TCGDEX_TYPE=Object.freeze({standard:'normal',holo:'holo'});
const key=(...parts)=>parts.join('|');

function isBaselineVariant(variant,targetType){
  return variant?.type===targetType
    && (variant.subtype===null||variant.subtype===undefined||variant.subtype==='')
    && (variant.foil===null||variant.foil===undefined||variant.foil==='')
    && Array.isArray(variant.stamp)
    && variant.stamp.length===0
    && Number.isSafeInteger(Number(variant.cardmarketProductId))
    && Number(variant.cardmarketProductId)>0;
}

async function build(db){
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const tcgdexCards=new Map();
  for(const set of repo.sets)for(const card of set.cards)tcgdexCards.set(card.tcgdexCardId,card);

  const [{artifact:catalogue,products},{artifact:guide,snapshot}]=await Promise.all([
    fetchCardmarketPokemonSinglesCatalogue(),
    fetchCardmarketPokemonPriceGuide(),
  ]);
  const productById=new Map(products.map(p=>[String(p.sourceRecordId),p]));
  const priceById=new Map(snapshot.priceGuides.map(r=>[String(r.idProduct),r]));

  const {rows:identityRows}=await db.query(`
    SELECT i.id,i.printing_id,i.set_id,i.variant_code,p.name,p.collector_number,s.name AS set_name,
           array_agg(DISTINCT t.source_record_id ORDER BY t.source_record_id) AS tcgdex_card_ids
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    JOIN fatedrop_card_source_mappings t ON t.card_identity_id=i.id AND t.source_name='tcgdex'
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )
    GROUP BY i.id,i.printing_id,i.set_id,i.variant_code,p.name,p.collector_number,s.name
    ORDER BY i.id`);

  const {rows:existing}=await db.query(`
    SELECT card_identity_id,source_record_id,source_variant_key
    FROM fatedrop_card_source_mappings
    WHERE source_name='cardmarket'`);
  const existingSource=new Map(existing.map(r=>[key(r.source_record_id,r.source_variant_key),r.card_identity_id]));
  const existingCanonical=new Map(existing.map(r=>[key(r.card_identity_id,r.source_variant_key),String(r.source_record_id)]));

  const counts={
    eligibleUnmappedWithTcgdex:identityRows.length,
    singleTcgdexCardLink:0,
    cardEvidenceFound:0,
    withTargetBaselineVariant:0,
    oneDistinctBaselineProductId:0,
    multipleDistinctBaselineProductIds:0,
    productExistsInOfficialCatalogue:0,
    meaningfulTargetPriceLane:0,
    safeExactMappings:0,
    ownershipConflicts:0,
    batchSourceConflicts:0,
    batchCanonicalConflicts:0,
  };
  const reasons={},raw=[],samples=[];
  const addReason=(reason)=>{reasons[reason]=(reasons[reason]||0)+1;};

  for(const row of identityRows){
    if(!Array.isArray(row.tcgdex_card_ids)||row.tcgdex_card_ids.length!==1){
      addReason('multiple_tcgdex_card_links');
      continue;
    }
    counts.singleTcgdexCardLink++;
    const tcgdexCardId=row.tcgdex_card_ids[0];
    const card=tcgdexCards.get(tcgdexCardId);
    if(!card){addReason('tcgdex_card_evidence_missing');continue;}
    counts.cardEvidenceFound++;

    const targetType=TARGET_TCGDEX_TYPE[row.variant_code];
    const baseline=card.variants.filter(v=>isBaselineVariant(v,targetType));
    if(baseline.length===0){addReason('no_exact_baseline_variant_for_target_finish');continue;}
    counts.withTargetBaselineVariant++;

    const productIds=[...new Set(baseline.map(v=>String(v.cardmarketProductId)))];
    if(productIds.length!==1){
      counts.multipleDistinctBaselineProductIds++;
      addReason('multiple_explicit_product_ids_for_exact_baseline_finish');
      continue;
    }
    counts.oneDistinctBaselineProductId++;

    const sourceRecordId=productIds[0];
    const product=productById.get(sourceRecordId);
    if(!product){addReason('explicit_product_missing_from_current_official_catalogue');continue;}
    counts.productExistsInOfficialCatalogue++;

    const lane=PRICE_LANE[row.variant_code];
    const priceRow=priceById.get(sourceRecordId);
    if(!priceRow||!hasMeaningfulCardmarketLane(priceRow,lane)){
      addReason('explicit_product_has_no_meaningful_target_price_lane');
      continue;
    }
    counts.meaningfulTargetPriceLane++;

    const sourceVariantKey=SOURCE_VARIANT[row.variant_code];
    const sourceKey=key(sourceRecordId,sourceVariantKey);
    const canonicalKey=key(row.id,sourceVariantKey);
    if(existingSource.has(sourceKey)&&existingSource.get(sourceKey)!==row.id){
      counts.ownershipConflicts++;addReason('target_source_finish_owned_by_other_identity');continue;
    }
    if(existingCanonical.has(canonicalKey)&&existingCanonical.get(canonicalKey)!==sourceRecordId){
      counts.ownershipConflicts++;addReason('target_identity_finish_owned_by_other_product');continue;
    }

    raw.push({
      cardIdentityId:row.id,
      printingId:row.printing_id,
      setId:row.set_id,
      setName:row.set_name,
      name:row.name,
      collectorNumber:row.collector_number,
      variantCode:row.variant_code,
      tcgdexCardId,
      tcgdexTargetType:targetType,
      sourceRecordId,
      sourceVariantKey,
      sourceExpansionId:product.sourceExpansionId,
      cardmarketProductName:product.name,
      priceLane:lane,
      proof:{
        method:'pinned_tcgdex_exact_baseline_finish_explicit_cardmarket_product_id',
        pinnedTcgdexRevision:process.env.TCGDEX_REVISION||null,
        baselineVariantCount:baseline.length,
        baselineVariants:baseline,
      },
    });
  }

  const sourceOwners=new Map(),canonicalOwners=new Map(),badSource=new Set(),badCanonical=new Set();
  for(const row of raw){
    const sk=key(row.sourceRecordId,row.sourceVariantKey),ck=key(row.cardIdentityId,row.sourceVariantKey);
    if(sourceOwners.has(sk)&&sourceOwners.get(sk)!==row.cardIdentityId)badSource.add(sk);else sourceOwners.set(sk,row.cardIdentityId);
    if(canonicalOwners.has(ck)&&canonicalOwners.get(ck)!==row.sourceRecordId)badCanonical.add(ck);else canonicalOwners.set(ck,row.sourceRecordId);
  }
  counts.batchSourceConflicts=badSource.size;
  counts.batchCanonicalConflicts=badCanonical.size;
  const candidates=raw.filter(row=>!badSource.has(key(row.sourceRecordId,row.sourceVariantKey))&&!badCanonical.has(key(row.cardIdentityId,row.sourceVariantKey)));
  counts.safeExactMappings=candidates.length;

  const bySet={};
  const byVariant={};
  for(const row of candidates){
    bySet[row.setName]=(bySet[row.setName]||0)+1;
    byVariant[row.variantCode]=(byVariant[row.variantCode]||0)+1;
    if(samples.length<250)samples.push(row);
  }

  return{
    status:'audit_complete',productionWrites:false,
    source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:catalogue.sha256,cardmarketPriceGuideSha256:guide.sha256},
    policy:{
      oneTcgdexCardLinkRequired:true,
      standardRequiresBaselineNormal:true,
      holoRequiresBaselineHolo:true,
      reverseExcluded:true,
      stampsExcluded:true,
      specialFoilsExcluded:true,
      currentOfficialCardmarketProductRequired:true,
      meaningfulTargetFinishPriceLaneRequired:true,
      ownershipFailClosed:true,
    },
    counts,reasons,byVariant,bySet,candidates,samples,
  };
}

async function main(){
  if(process.env.MAPPING_WRITE==='true')throw new Error('Audit is read-only and cannot write mappings');
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});const db=await pool.connect();let report;
  try{report=await build(db);}catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{
    db.release();await pool.end();
    await writeFile(`${process.env.RUNNER_TEMP||'.'}/cardmarket-tcgdex-explicit-baseline-finish-audit.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:report.status,counts:report.counts,reasons:report.reasons,byVariant:report.byVariant,bySet:report.bySet,samples:report.samples?.slice(0,20)},null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
