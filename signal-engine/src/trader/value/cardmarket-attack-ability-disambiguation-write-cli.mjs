import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { auditCardmarketAttackAbilityDisambiguation } from './cardmarket-attack-ability-disambiguation-audit-cli.mjs';

const stableId=(prefix,parts)=>prefix+'_'+createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24);

async function persist(db,report){
  if(report.status!=='audit_complete') throw new Error('Attack/ability audit is not persistence-ready');
  if(!Array.isArray(report.safe) || report.safe.length!==report.counts?.safeMappings) throw new Error('Safe mapping count does not match audit payload');
  await db.query('BEGIN');
  try{
    for(const r of report.safe){
      const source=await db.query(`SELECT card_identity_id FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND source_record_id=$1 AND source_variant_key=$2`,
        [r.sourceRecordId,r.sourceVariantKey]);
      if(source.rows[0] && source.rows[0].card_identity_id!==r.cardIdentityId) throw new Error('Cardmarket source ownership changed');
      const canonical=await db.query(`SELECT source_record_id FROM fatedrop_card_source_mappings
        WHERE source_name='cardmarket' AND card_identity_id=$1 AND source_variant_key=$2`,
        [r.cardIdentityId,r.sourceVariantKey]);
      if(canonical.rows[0] && String(canonical.rows[0].source_record_id)!==r.sourceRecordId) throw new Error('Canonical Cardmarket mapping changed');
      const id=stableId('fdcardmap',[r.cardIdentityId,'cardmarket',r.sourceRecordId,r.sourceVariantKey]);
      await db.query(`INSERT INTO fatedrop_card_source_mappings(
        id,card_identity_id,source_name,source_record_id,source_variant_key,source_version,first_observed_at,last_observed_at
      ) VALUES($1,$2,'cardmarket',$3,$4,$5,$6,$6) ON CONFLICT(id) DO NOTHING`,
        [id,r.cardIdentityId,r.sourceRecordId,r.sourceVariantKey,report.source.cardmarketCatalogueSha256,Date.now()]);
    }
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
  return {saved:report.safe.length};
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();
  let report;
  try{
    report=await auditCardmarketAttackAbilityDisambiguation(db);
    const persistence=await persist(db,report);
    report={...report,status:'write_complete',productionWrites:true,persistence};
  }catch(e){
    report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};
    process.exitCode=1;
  }finally{
    db.release();await pool.end();
    await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-attack-ability-disambiguation-write.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:report.status,counts:report.counts,persistence:report.persistence},null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
