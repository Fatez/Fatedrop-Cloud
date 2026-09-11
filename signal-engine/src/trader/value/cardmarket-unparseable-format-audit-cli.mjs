import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonSinglesCatalogue } from './cardmarket-source-client.mjs';
import { parseCardmarketSingleProductName } from './cardmarket-crosswalk.mjs';
import { loadTcgdexRepositoryEvidence } from './tcgdex-repository-cardmarket-evidence.mjs';

function classify(name){
  const text=String(name||'').trim();
  if(!text) return 'empty';
  if(/\[[^\]]+\]\s*$/.test(text)) return 'trailing_square_bracket_suffix';
  if(/\([^()]+\)\s*$/.test(text)) return 'trailing_parenthetical_other';
  if(/\b[A-Z]{2,10}\s*[-–]\s*\d+[A-Za-z]?\b/.test(text)) return 'setcode_dash_collector';
  if(/\b\d+[A-Za-z]?\s*\/\s*\d+\b/.test(text)) return 'fraction_collector';
  if(/\b(?:SV|TG|GG|RC|XY|SM|SWSH|SVP|PR|PROMO)[- ]?\d+[A-Za-z]?\b/i.test(text)) return 'promo_or_gallery_number';
  if(/\bTheme Deck\b/i.test(text)) return 'theme_deck';
  if(/\bDeck\b/i.test(text)) return 'deck_label';
  if(/\bStamped\b|\bStaff\b|\bPrerelease\b|\bLeague\b/i.test(text)) return 'special_print_label';
  if(/\d/.test(text)) return 'contains_number_unparsed';
  return 'name_only_unparsed';
}

async function audit(db){
  const repo=loadTcgdexRepositoryEvidence(process.env.TCGDEX_REPO,{includeCards:false});
  const {artifact,products}=await fetchCardmarketPokemonSinglesCatalogue();

  const {rows:setRows}=await db.query(`
    SELECT s.id set_id,s.name set_name,sm.source_record_id tcgdex_set_id
    FROM fatedrop_card_sets s
    LEFT JOIN fatedrop_card_set_source_mappings sm
      ON sm.set_id=s.id AND sm.source_name='tcgdex'
    WHERE s.verification_status='verified'`);

  const {rows:unmapped}=await db.query(`
    SELECT DISTINCT i.set_id
    FROM fatedrop_card_identities i
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND i.variant_code IN ('standard','holo')
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_card_source_mappings m
        WHERE m.source_name='cardmarket' AND m.card_identity_id=i.id
      )`);

  const unresolvedSetIds=new Set(unmapped.map(r=>r.set_id));
  const expansionMeta=new Map();
  for(const s of setRows){
    if(!unresolvedSetIds.has(s.set_id)) continue;
    const ev=s.tcgdex_set_id?repo.bySetId.get(s.tcgdex_set_id):null;
    const expansionId=Number(ev?.cardmarketExpansionId);
    if(Number.isSafeInteger(expansionId)&&expansionId>0){
      expansionMeta.set(expansionId,{setId:s.set_id,setName:s.set_name,tcgdexSetId:s.tcgdex_set_id});
    }
  }

  const rows=[];
  for(const p of products){
    const expansionId=Number(p.sourceExpansionId);
    if(!expansionMeta.has(expansionId)) continue;
    if(parseCardmarketSingleProductName(p.name)) continue;
    rows.push({
      expansionId,
      setName:expansionMeta.get(expansionId).setName,
      sourceRecordId:String(p.sourceRecordId),
      name:p.name,
      format:classify(p.name),
    });
  }

  const byFormat={};
  const bySet={};
  for(const r of rows){
    byFormat[r.format]=(byFormat[r.format]||0)+1;
    bySet[r.setName]=(bySet[r.setName]||0)+1;
  }
  const sortObj=o=>Object.fromEntries(Object.entries(o).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));

  const samples={};
  for(const r of rows){
    samples[r.format] ||= [];
    if(samples[r.format].length<20) samples[r.format].push({setName:r.setName,sourceRecordId:r.sourceRecordId,name:r.name});
  }

  return {
    status:'audit_complete',
    productionWrites:false,
    source:{tcgdexRevision:process.env.TCGDEX_REVISION||null,cardmarketCatalogueSha256:artifact.sha256},
    counts:{scopedUnparseableProducts:rows.length,formats:Object.keys(byFormat).length,scopedExpansions:expansionMeta.size},
    byFormat:sortObj(byFormat),
    bySet:sortObj(bySet),
    samples,
    rows,
  };
}

async function main(){
  validateProductionTarget(process.env.DATABASE_URL);
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2});
  const db=await pool.connect();let report;
  try{report=await audit(db);}
  catch(e){report={status:'blocked',productionWrites:false,error:e instanceof Error?e.message:String(e)};process.exitCode=1;}
  finally{
    db.release();await pool.end();
    await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-unparseable-format-audit.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:report.status,counts:report.counts,byFormat:report.byFormat},null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
