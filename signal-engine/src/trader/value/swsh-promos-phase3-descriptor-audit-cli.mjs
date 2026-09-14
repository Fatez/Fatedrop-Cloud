import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { hasSupportedCentralCardmarketLane, providerDescriptorIsUniqueSubset, providerDescriptorTerms, tcgdexDescriptorEvidence } from './cardmarket-approved-residual-recovery-cli.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { build as buildPhase2 } from './swsh-promos-phase2-variant-audit-cli.mjs';

const REV='5b6a2859f454972477a9953ffe5cb554d24c45e9', SET='swshp', EXP=2916;
const key=(...v)=>v.map(x=>String(x??'').trim()).join('|');
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function build(db){
  if(String(process.env.TCGDEX_REVISION||'')!==REV) throw new Error('TCGdex revision drift');
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
  const set=repo.bySetId.get(SET); if(!set||Number(set.cardmarketExpansionId)!==EXP) throw new Error('SWSH promo scope drift');
  const [catalogue,guide]=await Promise.all([fetchCardmarketPokemonSinglesCatalogue(),fetchCardmarketPokemonPriceGuide()]);
  const p2=await buildPhase2(db,{repoEvidence:repo,sources:{catalogue,guide}});
  const input=p2.rows.filter(r=>r.status==='HOLD_MULTIPLE_ORDINARY_VARIANT_PRODUCT_IDS');
  if(input.length!==55) throw new Error(`Phase3 cohort drift ${input.length}`);
  const productById=new Map(catalogue.products.map(p=>[String(p.sourceRecordId),p]));
  const priceById=new Map(guide.snapshot.priceGuides.map(p=>[String(p.idProduct),p]));
  const cards=new Map(set.cards.map(c=>[c.tcgdexCardId,c]));
  const {rows:ownerRows}=await db.query("SELECT card_identity_id,source_record_id,source_variant_key FROM fatedrop_card_source_mappings WHERE source_name='cardmarket'");
  const owners=new Map(); for(const o of ownerRows){const k=key(o.source_record_id,o.source_variant_key),s=owners.get(k)||new Set();s.add(o.card_identity_id);owners.set(k,s);}
  const rows=[];
  for(const r of input){
    const terms=tcgdexDescriptorEvidence(cards.get(r.tcgdexCardId));
    const matches=r.ordinaryExplicitProductIds.map(id=>productById.get(String(id))).filter(Boolean)
      .filter(p=>Number(p.sourceExpansionId)===EXP&&rootProductNameMatches(r.name,p.name))
      .map(p=>({p,t:providerDescriptorTerms(p.name)})).filter(x=>providerDescriptorIsUniqueSubset(x.t,terms));
    let status,w=null;
    if(matches.length===0) status='HOLD_NO_UNIQUE_DESCRIPTOR_MATCH';
    else if(matches.length>1) status='HOLD_MULTIPLE_DESCRIPTOR_MATCHES';
    else {w=matches[0]; const own=owners.get(key(w.p.sourceRecordId,'holo')); if(own?.size&&!(own.size===1&&own.has(r.cardIdentityId))) status='HOLD_PRODUCT_ALREADY_OWNED';}
    let standard=false,holo=false;
    if(!status&&w){const pr=priceById.get(String(w.p.sourceRecordId));standard=hasSupportedCentralCardmarketLane(pr,'standard');holo=hasSupportedCentralCardmarketLane(pr,'holo');status=holo?'READY_HOLO_LANE':standard?'REVIEW_BASE_LANE_ELIGIBLE':'RESOLVED_MAPPING_PRICE_UNAVAILABLE';}
    rows.push({cardIdentityId:r.cardIdentityId,collectorNumber:r.collectorNumber,name:r.name,status,sourceRecordId:w?String(w.p.sourceRecordId):null,cardmarketProductName:w?.p.name??null,providerDescriptorTerms:w?.t??[],tcgdexDescriptorTerms:terms,standardLane:standard,holoLane:holo,ordinaryExplicitProductIds:r.ordinaryExplicitProductIds});
  }
  const candidates=rows.filter(r=>['READY_HOLO_LANE','REVIEW_BASE_LANE_ELIGIBLE','RESOLVED_MAPPING_PRICE_UNAVAILABLE'].includes(r.status));
  const reasons={}; for(const r of rows) reasons[r.status]=(reasons[r.status]||0)+1;
  return {status:'phase3_descriptor_audit_complete',productionWrites:false,source:{phase2Run:34811316030,tcgdexRevision:REV,cardmarketExpansionId:EXP,cardmarketCatalogueSha256:catalogue.artifact.sha256,cardmarketPriceGuideSha256:guide.artifact.sha256,sourceSnapshotId:guide.snapshot.sourceSnapshotId},counts:{input:55,candidates:candidates.length,directlyPriceable:candidates.filter(r=>r.status==='READY_HOLO_LANE').length,baseLaneReview:candidates.filter(r=>r.status==='REVIEW_BASE_LANE_ELIGIBLE').length,resolvedPriceUnavailable:candidates.filter(r=>r.status==='RESOLVED_MAPPING_PRICE_UNAVAILABLE').length,held:rows.length-candidates.length,ownershipCollisions:rows.filter(r=>r.status==='HOLD_PRODUCT_ALREADY_OWNED').length},reasons,candidateDigest:digest(candidates.map(r=>[r.cardIdentityId,r.sourceRecordId,r.status]).sort()),candidates,rows};
}

validateProductionTarget(process.env.DATABASE_URL);
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1}),db=await pool.connect();
try{await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const report=await build(db);await writeFile(`${process.env.RUNNER_TEMP||process.cwd()}/swsh-promos-phase3-descriptor-audit.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,candidates:undefined,rows:undefined},null,2));await db.query('COMMIT');}catch(e){try{await db.query('ROLLBACK')}catch{}throw e}finally{db.release();await pool.end();}
