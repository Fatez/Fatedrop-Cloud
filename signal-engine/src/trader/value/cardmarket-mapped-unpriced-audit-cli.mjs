import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { validateProductionTarget } from '../catalogue/production-target-check.mjs';
import { fetchCardmarketPokemonPriceGuide } from './cardmarket-source-client.mjs';
import { hasMeaningfulCardmarketLane } from './cardmarket-adapter.mjs';

const laneFor = Object.freeze({ normal:'standard', holo:'holo' });

async function audit(db){
  const { artifact, snapshot } = await fetchCardmarketPokemonPriceGuide();
  const priceByProduct = new Map(snapshot.priceGuides.map(r => [String(r.idProduct), r]));

  const { rows } = await db.query(`
    SELECT
      i.id AS card_identity_id,
      i.variant_code,
      i.language_code,
      s.name AS set_name,
      p.name AS card_name,
      p.collector_number,
      m.source_record_id,
      m.source_variant_key,
      EXISTS (
        SELECT 1 FROM fatedrop_market_observations o
        WHERE o.source_name='cardmarket'
          AND o.card_identity_id=i.id
          AND o.trend_price IS NOT NULL
          AND o.trend_price>0
      ) AS already_priced
    FROM fatedrop_card_identities i
    JOIN fatedrop_card_printings p ON p.id=i.printing_id
    JOIN fatedrop_card_sets s ON s.id=i.set_id
    JOIN fatedrop_card_source_mappings m
      ON m.card_identity_id=i.id AND m.source_name='cardmarket'
    WHERE i.verification_status='verified'
      AND i.language_code='en'
      AND NOT EXISTS (
        SELECT 1 FROM fatedrop_market_observations o
        WHERE o.source_name='cardmarket'
          AND o.card_identity_id=i.id
          AND o.trend_price IS NOT NULL
          AND o.trend_price>0
      )
    ORDER BY s.name,p.collector_number,i.variant_code`);

  const buckets = {
    reverse_holo_policy_hold: [],
    no_current_priceguide_product: [],
    current_product_but_no_valid_lane: [],
    valid_lane_should_be_ingestable: [],
    unsupported_variant_key: [],
  };

  for (const row of rows){
    if (row.variant_code==='reverse-holo'){
      buckets.reverse_holo_policy_hold.push(row);
      continue;
    }
    const lane=laneFor[row.source_variant_key];
    if (!lane){
      buckets.unsupported_variant_key.push(row);
      continue;
    }
    const priceRow=priceByProduct.get(String(row.source_record_id));
    if (!priceRow){
      buckets.no_current_priceguide_product.push(row);
      continue;
    }
    if (!hasMeaningfulCardmarketLane(priceRow,lane)){
      buckets.current_product_but_no_valid_lane.push(row);
      continue;
    }
    buckets.valid_lane_should_be_ingestable.push(row);
  }

  const counts=Object.fromEntries(Object.entries(buckets).map(([k,v])=>[k,v.length]));
  return {
    status:'audit_complete',
    productionWrites:false,
    source:{cardmarketPriceGuideSha256:artifact.sha256},
    counts:{mappedButUnpriced:rows.length,...counts},
    buckets
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
    await writeFile((process.env.RUNNER_TEMP||'.')+'/cardmarket-mapped-unpriced-audit.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({status:report.status,counts:report.counts},null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
