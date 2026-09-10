import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { activate, TABLES, recount } from '../src/trader/catalogue/activate-rehearsed-catalogue.mjs';
const url = process.env.CATALOGUE_COMPATIBILITY_TEST_URL;
test('PostgreSQL compatibility, conflicting natural keys, atomic rollback and replay', {skip:!url}, async () => {
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
    await local.query(`INSERT INTO fatedrop_tcgs VALUES ('pokemon','pokemon','Pokemon','active',1,1);
      INSERT INTO fatedrop_card_series (id,tcg_id,code,name,created_at,updated_at,verification_status,verified_at) VALUES ('series','pokemon','series','Series',1,1,'verified',1);
      INSERT INTO fatedrop_card_sets (id,tcg_id,series_id,code,name,created_at,updated_at,verification_status,verified_at)
        SELECT 's'||n,'pokemon','series','s'||n,'Set '||n,1,1,'verified',1 FROM generate_series(1,124) n;
      INSERT INTO fatedrop_card_printings (id,tcg_id,series_id,set_id,printing_code,collector_number,name,created_at,updated_at,verification_status,verified_at)
        SELECT 'p'||n,'pokemon','series','s'||n,'p'||n,'1','Card '||n,1,1,'verified',1 FROM generate_series(1,124) n;
      INSERT INTO fatedrop_card_identities (id,canonical_key,tcg_id,series_id,set_id,printing_id,collector_number,variant_code,language_code,verification_status,verified_at,created_at,updated_at)
        SELECT 'c'||n,'c'||n,'pokemon','series','s'||s,'p'||s,'1','fixture-'||n,'en','verified',1,1,1
        FROM (SELECT n,CASE WHEN n<=17312 THEN 1 ELSE 92+(n%33) END s FROM generate_series(1,24084) n) x;
      INSERT INTO fatedrop_card_source_mappings (id,card_identity_id,source_name,source_record_id,source_variant_key,first_observed_at,last_observed_at)
        SELECT 'm'||n,'c'||n,'fixture','r'||n,'standard',1,1 FROM generate_series(1,24084) n;`);
    for (const table of Object.keys(TABLES)) {
      let rows=(await local.query(`SELECT * FROM ${table}`)).rows;
      if(table==='fatedrop_card_sets') rows=rows.filter(r=>Number(r.id.slice(1))<=91);
      if(table==='fatedrop_card_printings') rows=rows.filter(r=>Number(r.id.slice(1))<=91);
      if(table==='fatedrop_card_identities') rows=rows.filter(r=>Number(r.id.slice(1))<=17312);
      if(table==='fatedrop_card_source_mappings') rows=rows.filter(r=>Number(r.id.slice(1))<=17312);
      if(rows.length) await production.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(rows)]);
    }
    await production.query("UPDATE fatedrop_card_sets SET name='Preserve me' WHERE id='s1'");
    const saved=await recount(local);
    const evidence={status:'passed',productionWrites:false,sourceRevision:'8b4e387930ead7be6595b4d4c59b7ba7a3a79f08',saved,replayed:saved,intentionalQuarantineSetIds:['base2','base3','base5','gym1','neo1','neo2','neo3','neo4'],unexplainedZeroSavedSetIds:[],sourceFailures:[],crosswalk:{matched:132},sets:Array.from({length:132},()=>({savedCards:1}))};
    const before=await recount(production);
    const check={}; await activate({production,local,evidence,report:check});
    assert.equal(check.compatibility,'passed'); assert.deepEqual(await recount(production),before);
    assert.equal(check.expected.verified_identities,24084);
    await production.query("INSERT INTO fatedrop_card_source_mappings VALUES ('collision','c1','fixture','r24084','standard',NULL,NULL,1,1)");
    await assert.rejects(activate({production,local,evidence,activate:true,report:{}}),/unique|duplicate/);
    assert.equal((await recount(production)).verified_identities,17312);
    await production.query("DELETE FROM fatedrop_card_source_mappings WHERE id='collision'");
    await production.query(`CREATE FUNCTION reject_new_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='s92' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_new BEFORE INSERT ON fatedrop_card_sets FOR EACH ROW EXECUTE FUNCTION reject_new_fixture()`);
    await assert.rejects(activate({production,local,evidence,activate:true,report:{}}),/fixture rollback/);
    assert.deepEqual(await recount(production),before);
    await production.query('DROP TRIGGER reject_new ON fatedrop_card_sets');
    const report={}; await activate({production,local,evidence,activate:true,report});
    assert.equal(report.status,'activated_and_verified');
    assert.deepEqual(report.after,saved);
    assert.equal((await production.query("SELECT name FROM fatedrop_card_sets WHERE id='s1'")).rows[0].name,'Preserve me');
    const replay={}; await activate({production,local,evidence,activate:true,report:replay});
    assert.ok(Object.values(replay.additions).every(count=>count===0));
  } finally {
    production.release();local.release();await pp.end();await admin.end();
  }
});
