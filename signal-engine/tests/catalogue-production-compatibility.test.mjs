import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, planUnion, validateEvidence } from '../src/trader/catalogue/activate-rehearsed-catalogue.mjs';
const empty = () => Object.fromEntries(Object.keys(TABLES).map(table => [table, []]));
const saved = () => ({verified_sets:165,printings:20023,verified_identities:27725,source_mappings:27725,orphan_sets:0,orphan_printings:0,orphan_mappings:0,duplicate_identities:0});
const evidence = () => ({status:'passed',productionWrites:false,sourceRevision:'8b4e387930ead7be6595b4d4c59b7ba7a3a79f08',saved:saved(),replayed:saved(),intentionalQuarantineSetIds:['base2','base3','base5','gym1','neo1','neo2','neo3','neo4'],unexplainedZeroSavedSetIds:[],sourceFailures:[],setBlockers:[],crosswalk:{matched:165},sets:Array(165).fill({})});
test('accepts only the complete 165-set binder rehearsal and all eight identity quarantines', () => {
  validateEvidence(evidence());
  for (const mutate of [r=>r.saved.verified_sets=157,r=>r.setBlockers=[{setId:'blocked'}],r=>r.saved.printings--,r=>r.saved.source_mappings--,r=>r.sourceRevision='other',r=>r.intentionalQuarantineSetIds.pop(),r=>r.sourceFailures.push({setId:'x'}),r=>r.unexplainedZeroSavedSetIds.push('x'),r=>r.replayed.verified_identities++,r=>r.productionWrites=true]) {
    const report=evidence(); mutate(report); assert.throws(()=>validateEvidence(report));
  }
});
test('preserves existing metadata and production-only rows; inserts only missing rows', () => {
  const old=empty(), candidate=empty();
  old.fatedrop_card_sets=[{id:'existing',tcg_id:'pokemon',series_id:'sv',code:'sv1',verification_status:'verified',name:'Existing title',updated_at:'1'},{id:'production-only'}];
  candidate.fatedrop_card_sets=[{...old.fatedrop_card_sets[0],name:'Provider title',updated_at:'2'},{id:'new'}];
  const before=structuredClone(old), plan=planUnion(old,candidate);
  assert.deepEqual(old,before);
  assert.deepEqual(plan.additions.fatedrop_card_sets,[{id:'new'}]);
  assert.deepEqual(plan.retainedOnly.fatedrop_card_sets,['production-only']);
  assert.deepEqual(plan.differences.fatedrop_card_sets,[{id:'existing',fields:['name','updated_at'],action:'preserved_existing'}]);
});
test('blocks changed identity, edition/finish, language, status and mapping targets', () => {
  for (const [table,fields] of Object.entries(TABLES)) for (const field of fields) {
    const old=empty(), candidate=empty();
    old[table]=[{id:'same',[field]:'original'}]; candidate[table]=[{id:'same',[field]:'different'}];
    assert.throws(()=>planUnion(old,candidate),new RegExp('incompatible '+field));
  }
});
test('duplicate candidate IDs fail and replay is idempotent', () => {
  const candidate=empty(); candidate.fatedrop_tcgs=[{id:'pokemon',code:'pokemon',status:'active'}];
  assert.ok(Object.values(planUnion(candidate,candidate).additions).every(rows=>rows.length===0));
  candidate.fatedrop_tcgs.push(candidate.fatedrop_tcgs[0]);
  assert.throws(()=>planUnion(empty(),candidate),/Duplicate/);
});
test('numeric padding preserves production rows and cannot hide structural changes', () => {
  for (const table of ['fatedrop_card_printings','fatedrop_card_identities']) {
    const old=empty(), candidate=empty();
    old[table]=[{id:'same',collector_number:'43',set_id:'set',printing_id:'printing',variant_code:'standard'}];
    candidate[table]=[{...old[table][0],collector_number:'043'}];
    const before=structuredClone(old);
    const plan=planUnion(old,candidate);
    assert.equal(plan.additions[table].length,0);
    assert.deepEqual(old,before);
    assert.deepEqual(plan.differences[table],[{id:'same',fields:['collector_number'],action:'preserved_existing'}]);
    for (const number of ['44','H043','43a','43/100',' 43']) {
      candidate[table][0].collector_number=number;
      assert.throws(()=>planUnion(old,candidate),/incompatible collector_number/);
    }
    candidate[table][0]={...old[table][0],collector_number:'043',set_id:'other'};
    assert.throws(()=>planUnion(old,candidate),/incompatible set_id/);
  }
});
