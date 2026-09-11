import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';

const SET_CROSSWALKS = Object.freeze([
  ['Destined Rivals','6096'],
  ['Hidden Fates Shiny Vault','2514'],
  ['BW Black Star Promos','1611'],
  ['Nintendo Black Star Promos','1608'],
  ['HGSS Black Star Promos','1610'],
  ['Astral Radiance Trainer Gallery','4979'],
  ['Silver Tempest Trainer Gallery','5142'],
  ['Lost Origin Trainer Gallery','5093'],
  ["McDonald's Collection 2014",'1652'],
  ["McDonald's Collection 2015",'1653'],
  ["McDonald's Collection 2022",'5128'],
  ['EX trainer Kit 2 (Plusle)','1627'],
  ['EX trainer Kit 2 (Minun)','1627'],
  ['SWSH Black Star Promos','4309'],
]);

const stableId=(parts)=>'fdsetmap_'+createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24);

async function build(db){
  const names=SET_CROSSWALKS.map(([name])=>name);
  const {rows}=await db.query(`
    SELECT id,name FROM fatedrop_card_sets
    WHERE verification_status='verified' AND name=ANY($1::text[])`,[names]);
  const byName=new Map(rows.map(r=>[r.name,r.id]));
  const missing=SET_CROSSWALKS.filter(([name])=>!byName.has(name)).map(([name])=>name);
  if(missing.length) throw new Error('Missing verified sets: '+missing.join(', '));

  const candidates=[];
  for(const [name,expansionId] of SET_CROSSWALKS){
    const setId=byName.get(name);
    const existing=await db.query(`
      SELECT source_record_id FROM fatedrop_card_set_source_mappings
      WHERE set_id=$1 AND source_name='cardmarket'`,[setId]);
    if(existing.rows[0]){
      if(String(existing.rows[0].source_record_id)!==String(expansionId)) throw new Error('Existing Cardmarket set mapping conflict for '+name);
      continue;
    }
    candidates.push({
      id:stableId([setId,'cardmarket',String(expansionId)]),
      setId,
      setName:name,
      sourceRecordId:String(expansionId),
      sourceVersion:'high-confidence-expansion-crosswalk-audit-2026-09-11'
    });
  }
  return {status:'ready',productionWrites:false,counts:{requested:SET_CROSSWALKS.length,newMappings:candidates.length},candidates};
}

async function persist(db,report){
  await db.query('BEGIN');
  try{
    for(const r of report.candidates){
      const check=await db.query(`SELECT source_record_id FROM fatedrop_card_set_source_mappings WHERE set_id=$1 AND source_name='cardmarket'`,[r.setId]);
      if(check.rows[0] && String(check.rows[0].source_record_id)!==r.sourceRecordId) throw new Error('Set mapping changed before write');
      await db.query(`INSERT INTO fatedrop_card_set_source_mappings(
        id,set_id,source_name,source_record_id,source_version,first_observed_at,last_observed_at
      ) VALUES($1,$2,'cardmarket',$3,$4,$5,$5) ON CONFLICT(id) DO NOTHING`,
      [r.id,r.setId,r.sourceRecordId,r.sourceVersion,Date.now()]);
    }
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();let report;
  try{
    report=await build(db);
    if(process.env.SET_MAPPING_WRITE==='true'){
      await persist(db,report);
      report={...report,status:'write_complete',productionWrites:true};
    }
  }catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{
    db.release();await pool.end();
    await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-highconfidence-expansion-write.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
