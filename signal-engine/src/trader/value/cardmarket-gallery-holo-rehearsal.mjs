import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { REVIEWED_GALLERY_HOLO, REVIEWED_GALLERY_HOLO_REVISION } from './cardmarket-reviewed-gallery-holo.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';
import { rootProductNameMatches } from './cardmarket-tcgdex-root-evidence.mjs';
import { normaliseCollectorNumber } from '../card-identity.mjs';
import { prepareCardmarketDailyPriceGuideBatch } from './cardmarket-daily-ingest.mjs';
import { fetchCardmarketPokemonSinglesCatalogue, fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
validateProductionTarget(process.env.DATABASE_URL);
assert.equal(process.env.TCGDEX_REVISION,REVIEWED_GALLERY_HOLO_REVISION);
const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:true});
const cards=new Map(repo.sets.flatMap(s=>s.cards.map(c=>[c.tcgdexCardId,c])));
const {artifact:catalogue,products}=await fetchCardmarketPokemonSinglesCatalogue();
const productMap=new Map(products.map(p=>[String(p.sourceRecordId),p]));
for(const e of REVIEWED_GALLERY_HOLO) {
 const c=cards.get(e.tcgdexCardId);
 assert.ok(c && rootProductNameMatches(e.name,c.name), 'Source card name conflict: '+e.tcgdexCardId);
 assert.equal(normaliseCollectorNumber(String(c.localId)),normaliseCollectorNumber(e.collectorNumber));
 assert.equal(c.variants.length,1);
 const v=c.variants[0];
 assert.equal(v.type,'holo');assert.equal(String(v.cardmarketProductId),e.source_record_id);
 assert.ok(!v.subtype && !v.foil && (!v.stamp || v.stamp.length===0));
 assert.ok(rootProductNameMatches(e.name,productMap.get(e.source_record_id)?.name));
}
const {artifact:guide,snapshot}=await fetchCardmarketPokemonPriceGuide();
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
const db=await pool.connect();
try {
 await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const batch=await prepareCardmarketDailyPriceGuideBatch({store:{pool:async()=>db},priceGuidePayload:{version:Number(snapshot.sourceVersion),createdAt:new Date(snapshot.sourceEffectiveAt).toISOString(),priceGuides:snapshot.priceGuides}});
 const ids=new Set(REVIEWED_GALLERY_HOLO.map(e=>e.card_identity_id));
 const accepted=batch.observations.filter(o=>ids.has(o.cardIdentityId));
 for (const o of accepted) {
  assert.equal(o.sourceVariantKey,'holo'); assert.equal(o.marketSegmentKey,'holo');
  assert.ok(['marketPrice','trendPrice','avg1d','avg7d','avg30d'].some(k=>Number.isFinite(o[k]) && o[k]>0),'Supported central price required');
 }
 assert.equal(accepted.length,136,'Every reviewed identity must produce an observation');
 assert.equal(new Set(accepted.map(o=>o.cardIdentityId)).size,136);
 const report={status:'rehearsal_passed',productionWrites:false,count:accepted.length,tcgdexRevision:REVIEWED_GALLERY_HOLO_REVISION,catalogueSha256:catalogue.sha256,guideSha256:guide.sha256,observations:accepted};
 await writeFile(process.env.RUNNER_TEMP+'/gallery-holo-rehearsal.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,observations:undefined}));
 await db.query('COMMIT');
} finally { await db.query('ROLLBACK'); db.release();await pool.end(); }
