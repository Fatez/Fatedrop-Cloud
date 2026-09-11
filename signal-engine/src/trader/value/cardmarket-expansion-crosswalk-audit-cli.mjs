import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { normaliseComparableName } from '../catalogue/reconcile.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

function stripProviderDescriptors(name){
  let value=String(name||'').trim()
    .replace(/^Nidoran\s+\[F\](?=\s|$)/i,'Nidoran female')
    .replace(/^Nidoran\s+\[M\](?=\s|$)/i,'Nidoran male');
  const square=/\s+\[[^[\]]+\]\s*$/;
  while(square.test(value)) value=value.replace(square,'').trim();
  return value;
}

function expansionLabel(row){
  for(const k of ['expansionName','nameExpansion','enExpansionName','expansion_name','expansion']){
    const v=row?.rawPayload?.[k];
    if(typeof v==='string'&&v.trim()) return v.trim();
  }
  return null;
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();
  let report;
  try{
    const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:false});
    const {artifact,products}=await fetchCardmarketPokemonSinglesCatalogue();

    const {rows:sets}=await db.query(`
      SELECT s.id AS set_id,s.name AS set_name,sm.source_record_id AS tcgdex_set_id
      FROM fatedrop_card_sets s
      JOIN fatedrop_card_set_source_mappings sm ON sm.set_id=s.id AND sm.source_name='tcgdex'
      WHERE s.verification_status='verified'`);

    const gaps=[];
    for(const s of sets){
      const evidence=repo.bySetId.get(s.tcgdex_set_id);
      const expansionId=Number(evidence?.cardmarketExpansionId);
      if(!Number.isSafeInteger(expansionId)||expansionId<=0) gaps.push(s);
    }

    const {rows:cards}=await db.query(`
      SELECT i.set_id,p.name
      FROM fatedrop_card_identities i
      JOIN fatedrop_card_printings p ON p.id=i.printing_id
      WHERE i.verification_status='verified' AND i.language_code='en'
        AND i.variant_code IN ('standard','holo')
        AND NOT EXISTS (
          SELECT 1 FROM fatedrop_card_source_mappings m
          WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
        )`);

    const canonicalNamesBySet=new Map();
    for(const c of cards){
      const n=normaliseComparableName(c.name);
      if(!n) continue;
      const set=canonicalNamesBySet.get(c.set_id)||new Set();
      set.add(n);canonicalNamesBySet.set(c.set_id,set);
    }

    const expansions=new Map();
    for(const p of products){
      const id=Number(p.sourceExpansionId);
      if(!Number.isSafeInteger(id)||id<=0) continue;
      let e=expansions.get(id);
      if(!e){e={id,label:expansionLabel(p),productNames:new Set(),productCount:0};expansions.set(id,e);}
      if(!e.label) e.label=expansionLabel(p);
      e.productCount++;
      const n=normaliseComparableName(stripProviderDescriptors(p.name));
      if(n) e.productNames.add(n);
    }

    const results=[];
    for(const s of gaps){
      const canon=canonicalNamesBySet.get(s.set_id)||new Set();
      const scored=[];
      for(const e of expansions.values()){
        let overlap=0;
        for(const n of canon) if(e.productNames.has(n)) overlap++;
        if(!overlap) continue;
        const setCoverage=canon.size?overlap/canon.size:0;
        const expansionCoverage=e.productNames.size?overlap/e.productNames.size:0;
        const score=overlap*10 + setCoverage*100 + expansionCoverage*25;
        scored.push({
          expansionId:e.id,expansionName:e.label,overlap,
          canonicalUniqueNames:canon.size,
          expansionUniqueNames:e.productNames.size,
          setCoverage:Number(setCoverage.toFixed(4)),
          expansionCoverage:Number(expansionCoverage.toFixed(4)),
          score:Number(score.toFixed(4))
        });
      }
      scored.sort((a,b)=>b.score-a.score||b.overlap-a.overlap||a.expansionId-b.expansionId);
      const top=scored[0]||null, second=scored[1]||null;
      const margin=top&&second?Number((top.score-second.score).toFixed(4)):top?top.score:0;
      const highConfidence=Boolean(top && top.overlap>=5 && top.setCoverage>=0.35 && (!second || margin>=25 || top.score>=second.score*1.25));
      results.push({
        setId:s.set_id,setName:s.set_name,tcgdexSetId:s.tcgdex_set_id,
        canonicalUniqueNames:canon.size,
        highConfidence,
        topCandidate:top,
        secondCandidate:second,
        scoreMargin:margin,
        top5:scored.slice(0,5)
      });
    }

    report={
      status:'audit_complete',
      productionWrites:false,
      source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:artifact.sha256},
      counts:{
        gapSets:gaps.length,
        highConfidenceSets:results.filter(r=>r.highConfidence).length,
        unresolvedSets:results.filter(r=>!r.highConfidence).length
      },
      results
    };
  }catch(e){
    report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};
    process.exitCode=1;
  }finally{
    db.release();await pool.end();
    await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-expansion-crosswalk-audit.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:report.status,counts:report.counts},null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
