import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { activate, TABLES, recount, recountMarketEvidence } from '../src/trader/catalogue/activate-rehearsed-catalogue.mjs';
const url = process.env.CATALOGUE_COMPATIBILITY_TEST_URL;
test('PostgreSQL compatibility preserves FatePrice history, conflicts roll back atomically, and replay is idempotent', {skip:!url}, async () => {
  const target = new URL(url);
  assert.equal(target.hostname,'localhost');
  assert.equal(target.pathname,'/fatedrop_catalogue_rehearsal');
  const admin = new Pool({connectionString:url});
  await admin.query('CREATE DATABASE catalogue_activation_fixture');
  const prodUrl = new URL(url); prodUrl.pathname='/catalogue_activation_fixture';
  const pp = new Pool({connectionString:prodUrl.toString()});
  const local=await admin.connect(), production=await pp.connect();
  try {
    for (const db of [local,production]) for (const name of ['fate-trader-card-identity.sql','fate-trader-catalogue-crosswalk.sql'])
      await db.query(await readFile(new URL('../database/'+name,import.meta.url),'utf8'));
    await production.query(await readFile(new URL('../database/fate-value-market-history.sql',import.meta.url),'utf8'));

    await local.query(`INSERT INTO fatedrop_tcgs VALUES ('pokemon','pokemon','Pokemon','active',1,1);
      INSERT INTO fatedrop_card_series (id,tcg_id,code,name,created_at,updated_at,verification_status,verified_at) VALUES ('series','pokemon','series','Series',1,1,'verified',1);
      INSERT INTO fatedrop_card_sets (id,tcg_id,series_id,code,name,created_at,updated_at,verification_status,verified_at)
        SELECT 's'||n,'pokemon','series','s'||n,'Set '||n,1,1,'verified',1 FROM generate_series(1,165) n;
      INSERT INTO fatedrop_card_printings (id,tcg_id,series_id,set_id,printing_code,collector_number,name,created_at,updated_at,verification_status,verified_at)
        SELECT 'p'||n,'pokemon','series',
          CASE WHEN n<=19087 THEN 's'||(1+((n-1)%157)) ELSE 's'||(158+((n-19088)%8)) END,
          'p'||n,n::text,'Card '||n,1,1,'verified',1 FROM generate_series(1,20023) n;
      INSERT INTO fatedrop_card_identities (id,canonical_key,tcg_id,series_id,set_id,printing_id,collector_number,variant_code,language_code,verification_status,verified_at,created_at,updated_at)
        SELECT 'c'||n,'c'||n,'pokemon','series',
          CASE WHEN p<=19087 THEN 's'||(1+((p-1)%157)) ELSE 's'||(158+((p-19088)%8)) END,
          'p'||p,p::text,'fixture-'||n,'en','verified',1,1,1
        FROM (SELECT n,CASE WHEN n<=27624 THEN 1+((n-1)%19087) ELSE 19088+((n-27625)%936) END p FROM generate_series(1,27720) n) x;
      INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,first_observed_at,last_observed_at)
        SELECT 'm'||n,'c'||n,'fixture','r'||n,'standard',1,1 FROM generate_series(1,27720) n;`);

    // Production starts at the previous 157-set catalogue. The new rehearsal is
    // additive, matching the real activation shape rather than replacing rows.
    for (const table of Object.keys(TABLES)) {
      let rows=(await local.query(`SELECT * FROM ${table}`)).rows;
      if(table==='fatedrop_card_sets') rows=rows.filter(r=>Number(r.id.slice(1))<=157);
      if(table==='fatedrop_card_printings') rows=rows.filter(r=>Number(r.id.slice(1))<=19087);
      if(table==='fatedrop_card_identities') rows=rows.filter(r=>Number(r.id.slice(1))<=27624);
      if(table==='fatedrop_card_source_mappings') rows=rows.filter(r=>Number(r.id.slice(1))<=27624);
      if(rows.length) await production.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(rows)]);
    }
    await production.query("UPDATE fatedrop_card_sets SET name='Preserve me' WHERE id='s1'");

    // One production-only exact Cardmarket mapping and observation proves that
    // catalogue activation preserves existing FatePrice history and its FKs.
    await production.query(`INSERT INTO fatedrop_card_source_mappings
      (id,card_identity_id,source_name,source_record_id,source_variant_key,first_observed_at,last_observed_at)
      VALUES ('cm1','c1','cardmarket','733750','normal',1,1);
      INSERT INTO fatedrop_market_ingest_runs
      (id,source_name,source_snapshot_id,source_version,started_at,completed_at,status,records_seen,records_accepted,records_rejected,metadata_json,created_at)
      VALUES ('run1','cardmarket','snapshot1','1',1,1,'completed',1,1,0,'{}',1);
      INSERT INTO fatedrop_market_observations
      (id,ingest_run_id,card_identity_id,card_source_mapping_id,source_name,source_snapshot_id,source_record_id,source_variant_key,market_segment_key,condition_code,currency_code,observed_at,source_effective_at,market_day,trend_price,metrics_json,raw_payload,content_fingerprint,created_at)
      VALUES ('price1','run1','c1','cm1','cardmarket','snapshot1','733750','normal','standard','unspecified','EUR',1,1,'2026-09-11',10,'{}','{}',repeat('a',64),1);`);

    const saved=await recount(local);
    assert.deepEqual(saved,{verified_sets:165,printings:20023,verified_identities:27720,source_mappings:27720,orphan_sets:0,orphan_printings:0,orphan_mappings:0,duplicate_identities:0});
    const evidence={status:'passed',productionWrites:false,sourceRevision:'8b4e387930ead7be6595b4d4c59b7ba7a3a79f08',saved,replayed:saved,intentionalQuarantineSetIds:['base2','base3','base5','gym1','neo1','neo2','neo3','neo4'],unexplainedZeroSavedSetIds:[],sourceFailures:[],setBlockers:[],crosswalk:{matched:165},sets:Array.from({length:165},()=>({savedCards:1}))};
    const before=await recount(production);
    const marketBefore=await recountMarketEvidence(production);
    assert.equal(before.verified_sets,157);
    assert.equal(before.printings,19087);
    assert.equal(before.verified_identities,27624);
    assert.deepEqual(marketBefore,{observations:1,distinct_priced_identities:1,orphan_price_identities:0,latest_market_day:'2026-09-11'});

    const check={}; await activate({production,local,evidence,report:check});
    assert.equal(check.compatibility,'passed');
    assert.deepEqual(await recount(production),before);
    assert.deepEqual(await recountMarketEvidence(production),marketBefore);
    assert.equal(check.expected.verified_identities,27720);
    assert.equal(check.expected.printings,20023);

    // A production-only natural-key collision must block the whole activation.
    await production.query("INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,first_observed_at,last_observed_at) VALUES ('collision','c1','fixture','r27720','standard',1,1)");
    await assert.rejects(activate({production,local,evidence,activate:true,report:{}}),/unique|duplicate/);
    assert.equal((await recount(production)).verified_identities,27624);
    assert.deepEqual(await recountMarketEvidence(production),marketBefore);
    await production.query("DELETE FROM fatedrop_card_source_mappings WHERE id='collision'");

    // A late failure after inserts begin must also roll the catalogue back without
    // touching the already-recorded market observation.
    await production.query("CREATE FUNCTION reject_new_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='s158' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_new BEFORE INSERT ON fatedrop_card_sets FOR EACH ROW EXECUTE FUNCTION reject_new_fixture()");
    await assert.rejects(activate({production,local,evidence,activate:true,report:{}}),/fixture rollback/);
    assert.deepEqual(await recount(production),before);
    assert.deepEqual(await recountMarketEvidence(production),marketBefore);
    await production.query('DROP TRIGGER reject_new ON fatedrop_card_sets');

    const report={}; await activate({production,local,evidence,activate:true,report});
    assert.equal(report.status,'activated_and_verified');
    assert.equal(report.after.verified_sets,165);
    assert.equal(report.after.printings,20023);
    assert.equal(report.after.verified_identities,27720);
    assert.equal(report.after.source_mappings,27721); // 27,720 rehearsal mappings + retained Cardmarket mapping.
    assert.deepEqual(report.marketEvidenceBefore,marketBefore);
    assert.deepEqual(report.marketEvidenceAfter,marketBefore);
    assert.deepEqual(await recountMarketEvidence(production),marketBefore);
    assert.equal((await production.query("SELECT name FROM fatedrop_card_sets WHERE id='s1'")).rows[0].name,'Preserve me');

    const replay={}; await activate({production,local,evidence,activate:true,report:replay});
    assert.ok(Object.values(replay.additions).every(count=>count===0));
    assert.deepEqual(replay.marketEvidenceBefore,marketBefore);
    assert.deepEqual(replay.marketEvidenceAfter,marketBefore);
  } finally {
    production.release();local.release();await pp.end();await admin.end();
  }
});