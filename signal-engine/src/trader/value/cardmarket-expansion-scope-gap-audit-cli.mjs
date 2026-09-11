import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();let report;
  try{
    const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:false});
    const {rows}=await db.query(`
      SELECT s.id AS set_id,s.name AS set_name,
             sm.source_record_id AS tcgdex_set_id,
             COUNT(i.id)::int AS unresolved_identities,
             COUNT(i.id) FILTER (WHERE i.variant_code='standard')::int AS standard,
             COUNT(i.id) FILTER (WHERE i.variant_code='holo')::int AS holo
      FROM fatedrop_card_sets s
      LEFT JOIN fatedrop_card_set_source_mappings sm
        ON sm.set_id=s.id AND sm.source_name='tcgdex'
      JOIN fatedrop_card_identities i ON i.set_id=s.id
      WHERE s.verification_status='verified'
        AND i.verification_status='verified'
        AND i.language_code='en'
        AND i.variant_code IN ('standard','holo')
        AND NOT EXISTS (
          SELECT 1 FROM fatedrop_card_source_mappings m
          WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
        )
      GROUP BY s.id,s.name,sm.source_record_id
      ORDER BY unresolved_identities DESC,s.name`);
    const gaps=[];
    for(const row of rows){
      const evidence=row.tcgdex_set_id?repo.bySetId.get(row.tcgdex_set_id):null;
      const expansionId=Number(evidence?.cardmarketExpansionId);
      if(!Number.isSafeInteger(expansionId)||expansionId<=0){
        gaps.push({
          setId:row.set_id,setName:row.set_name,tcgdexSetId:row.tcgdex_set_id||null,
          unresolvedIdentities:row.unresolved_identities,standard:row.standard,holo:row.holo,
          reason:!row.tcgdex_set_id?'missing_tcgdex_set_mapping':!evidence?'tcgdex_set_missing_from_pinned_repo':'tcgdex_has_no_cardmarket_expansion_id'
        });
      }
    }
    report={status:'audit_complete',productionWrites:false,counts:{
      affectedSets:gaps.length,
      unresolvedIdentities:gaps.reduce((n,r)=>n+r.unresolvedIdentities,0),
      standard:gaps.reduce((n,r)=>n+r.standard,0),
      holo:gaps.reduce((n,r)=>n+r.holo,0)
    },gaps};
  }catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{
    db.release();await pool.end();
    await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-expansion-scope-gap-audit.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.counts||report,null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
