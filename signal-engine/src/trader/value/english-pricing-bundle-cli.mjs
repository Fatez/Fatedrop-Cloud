import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { assessBaselineFinishEvidence, rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';
import { digest, checkpointValid, combineRecoveryProposals } from './english-pricing-bundle.mjs';
import { build as stage0 } from './cardmarket-tcgdex-explicit-baseline-finish-recovery-cli.mjs';
import { build as stage1 } from './cardmarket-tcgdex-root-product-recovery-v2-cli.mjs';
import { build as stage2 } from './cardmarket-attack-ability-exact-recovery-cli.mjs';
import { build as stage3 } from './cardmarket-legacy-provider-metadata-recovery-cli.mjs';
import { build as stage4 } from './cardmarket-sibling-finish-exact-recovery-cli.mjs';
import { build as stage5 } from './cardmarket-residual-price-audit-cli.mjs';
import { build as stage6 } from './cardmarket-residual-duplicate-mapping-audit-cli.mjs';
import { build as stage7 } from './cardmarket-residual-holo-evidence-audit-cli.mjs';
const STAGES = [['tcgdex-explicit-baseline-finish-recovery',stage0],
['tcgdex-root-product-recovery-v2',stage1],
['attack-ability-exact-recovery',stage2],
['legacy-provider-metadata-recovery',stage3],
['sibling-finish-exact-recovery',stage4],
['residual-price-audit',stage5],
['residual-duplicate-mapping-audit',stage6],
['residual-holo-evidence-audit',stage7]];
const QUARANTINED = new Set(['base2','base3','base5','gym1','neo1','neo2','neo3','neo4']);
async function save(file,value) { await writeFile(file+'.tmp',JSON.stringify(value,null,2));await rename(file+'.tmp',file); }
const collector = v => String(v||'').toUpperCase().replace(/(^|[^0-9])0+(?=\d)/g,'$1');
async function main() {
  if(['MAPPING_WRITE','PRICE_WRITE','CORRECTION_WRITE'].some(k=>process.env[k]==='true') || process.env.CARDMARKET_MODE==='persist') throw new Error('Bundle preparation is read-only; activation requires separate reviewed evidence');
  validateProductionTarget(process.env.DATABASE_URL);
  const output=path.resolve(process.env.BUNDLE_OUTPUT || path.join(process.env.RUNNER_TEMP||'.','english-pricing-bundle'));
  await mkdir(output,{recursive:true});
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
  let db;
  try {
    // One official download per dataset per run; all eight stages reuse these objects.
    const [catalogue,guide]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
    const sources={catalogue,guide};
    const repoEvidence=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
    const cards=new Map(repoEvidence.sets.flatMap(s=>s.cards.map(c=>[c.tcgdexCardId,c])));
    const products=new Map(catalogue.products.map(p=>[String(p.sourceRecordId),p]));
    const prices=new Map(guide.snapshot.priceGuides.map(p=>[String(p.idProduct),p]));
    await save(path.join(output,'source-snapshots.json'),{catalogue:catalogue.artifact,guide:guide.artifact});
    db=await pool.connect();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {rows:identities}=await db.query(`SELECT i.id,i.variant_code,i.language_code,i.verification_status,p.name,p.collector_number,
      ARRAY(SELECT DISTINCT m.source_record_id FROM fatedrop_card_source_mappings m WHERE m.card_identity_id=i.id AND m.source_name='tcgdex' ORDER BY m.source_record_id) AS tcgdex_card_ids,
      ARRAY(SELECT DISTINCT m.source_record_id FROM fatedrop_card_set_source_mappings m WHERE m.set_id=i.set_id AND m.source_name='tcgdex' ORDER BY m.source_record_id) AS tcgdex_set_ids
      FROM fatedrop_card_identities i JOIN fatedrop_card_printings p ON p.id=i.printing_id
      WHERE i.language_code='en' AND i.verification_status='verified' AND i.variant_code IN ('standard','holo') ORDER BY i.id`);
    const {rows:mappings}=await db.query("SELECT id,card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket' ORDER BY id");
    const {rows:pricedRows}=await db.query("SELECT DISTINCT card_identity_id FROM fatedrop_market_observations WHERE source_name='cardmarket' AND greatest(market_price,trend_price,avg_1d,avg_7d,avg_30d)>0 ORDER BY card_identity_id");
    const priced=new Set(pricedRows.map(r=>r.card_identity_id));
    const backlog=identities.filter(i=>!priced.has(i.id));
    const {rows:setMappings}=await db.query("SELECT * FROM fatedrop_card_set_source_mappings ORDER BY id");
    const context=digest({setMappings,code:process.env.GITHUB_SHA||'local',revision:process.env.TCGDEX_REVISION,source:[catalogue.artifact.sha256,guide.artifact.sha256],identities,mappings,pricedRows});
    const reports=[], failures=[];
    for(const [stage,build] of STAGES) {
      const file=path.join(output,stage+'.json');let checkpoint;
      try{checkpoint=JSON.parse(await readFile(file,'utf8'));}catch{}
      if(checkpointValid(checkpoint,context)){
        reports.push({stage,report:checkpoint.output});console.log(JSON.stringify({stage,status:'resumed'}));continue;
      }
      await db.query('SAVEPOINT recovery_stage');
      try {
        console.log(JSON.stringify({stage,status:'running'}));
        const report=await build(db,{sources,repoEvidence});
        if(report.productionWrites!==false || !['audit_complete','clean','clean_subset_available'].includes(report.status)) throw new Error('Stage did not produce a complete read-only report');
        await save(file,{context,outputDigest:digest(report),output:report});
        reports.push({stage,report});
        await db.query('RELEASE SAVEPOINT recovery_stage');
        console.log(JSON.stringify({stage,status:'complete',candidates:report.candidates?.length||0}));
      } catch(error) {
        await db.query('ROLLBACK TO SAVEPOINT recovery_stage');
        await db.query('RELEASE SAVEPOINT recovery_stage');
        failures.push({stage,error:error.message});
        console.log(JSON.stringify({stage,status:'failed',error:error.message}));
      }
    }
    const combined=combineRecoveryProposals({identities:backlog,mappings,reports,validate:(row,identity)=>{
      if(identity.tcgdex_set_ids.some(id=>QUARANTINED.has(id)))return 'intentional_first_edition_quarantine';
      if(identity.tcgdex_card_ids.length!==1)return 'multiple_or_missing_tcgdex_links';
      const card=cards.get(identity.tcgdex_card_ids[0]),product=products.get(String(row.sourceRecordId));
      if(!card||!product)return 'missing_exact_source_record';
      if(row.tcgdexCardId && row.tcgdexCardId!==card.tcgdexCardId)return 'tcgdex_link_conflict';
      if(collector(card.localId)!==collector(identity.collector_number))return 'collector_number_conflict';
      if(!rootProductNameMatches(identity.name,card.name)||!rootProductNameMatches(identity.name,product.name))return 'exact_name_conflict';
      const finish=assessBaselineFinishEvidence(card,identity.variant_code,Number(row.sourceRecordId));
      return finish.ok ? null : finish.reason;
    }});
    // Apply existing pricing policy in memory. Never write observations during preparation.
    const batch=await prepareCardmarketDailyPriceGuideBatch({store:{pool:async()=>db},priceGuidePayload:guide.artifact.payload,lanes:['standard','holo']});
    const readyExisting=new Set(batch.observations.map(o=>o.cardIdentityId));
    const proposals=new Map(combined.candidates.map(c=>[c.cardIdentityId,c]));
    const mapped=new Set(mappings.map(m=>m.card_identity_id));
    const heldById=new Map();
    for(const h of combined.held){const list=heldById.get(h.cardIdentityId)||[];list.push(h.reason);heldById.set(h.cardIdentityId,list);}
    const classifications=backlog.map(identity=>{
      const candidate=proposals.get(identity.id),isMapped=mapped.has(identity.id);
      const lane=identity.variant_code==='standard'?'standard':'holo';
      const candidatePrice=candidate && prices.get(String(candidate.sourceRecordId));
      const outcome=isMapped ? (readyExisting.has(identity.id)?'existing_mapping_ready_for_ingestion':'mapped_requires_review_or_provider_data')
        : candidate ? (candidatePrice&&hasMeaningfulCardmarketLane(candidatePrice,lane)?'mapping_candidate_with_price':'mapping_candidate_without_price')
        : 'unmapped_requires_evidence';
      return {cardIdentityId:identity.id,name:identity.name,collectorNumber:identity.collector_number,variant:identity.variant_code,
        tcgdexCardIds:identity.tcgdex_card_ids,outcome,reasons:[...new Set(heldById.get(identity.id)||[])],candidate:candidate||null};
    });
    const counts=classifications.reduce((a,r)=>(a[r.outcome]=(a[r.outcome]||0)+1,a),{});
    const bundle={schemaVersion:1,status:failures.length?'incomplete_review_required':'review_required',productionWrites:false,activationAuthorized:false,
      context,source:{tcgdexRevision:process.env.TCGDEX_REVISION,catalogueSha256:catalogue.artifact.sha256,guideSha256:guide.artifact.sha256},
      baseline:{verifiedStandardHolo:identities.length,priced:identities.length-backlog.length,unpriced:backlog.length},
      counts,stageFailures:failures,candidates:combined.candidates,held:combined.held,classifications};
    bundle.bundleDigest=digest(bundle);
    await save(path.join(output,'bundle.json'),bundle);
    await db.query('COMMIT');
    console.log(JSON.stringify({status:bundle.status,bundleDigest:bundle.bundleDigest,baseline:bundle.baseline,counts,stageFailures:failures,productionWrites:false}));
    if(failures.length)process.exitCode=1;
  } catch(error) {
    if(db)await db.query('ROLLBACK').catch(()=>{});
    await save(path.join(output,'failure.json'),{status:'blocked',productionWrites:false,error:error.message});
    process.exitCode=1;console.error(error.message);
  } finally {if(db)db.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
