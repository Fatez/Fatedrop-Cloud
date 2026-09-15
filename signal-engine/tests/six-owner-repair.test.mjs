import test from 'node:test';
import assert from 'node:assert/strict';
import {cases,rehearsalSql} from '../scripts/six-owner-repair.mjs';
test('six-owner repair pins six lanes, twelve identities and 27 observations',()=>{
 assert.equal(cases.length,6);
 assert.equal(new Set(cases.flatMap(r=>[r[3],r[4]])).size,12);
 assert.equal(new Set(cases.flatMap(r=>[r[0]+'/'+r[1],r[2]+'/'+r[1]])).size,12);
 assert.equal(cases.reduce((n,r)=>n+r[10],0),27);
});
test('operator SQL only rehearses and preserves observation payloads and other lanes',()=>{
 const sql=rehearsalSql();
 assert.match(sql,/ROLLBACK;$/);
 assert.doesNotMatch(sql,/\nCOMMIT;/);
 assert.match(sql,/Observation preservation failed/);
 assert.match(sql,/Unrelated lane changed/);
 assert.match(sql,/Canonical identities changed/);
 assert.ok(sql.indexOf('UPDATE fatedrop_market_observations')<sql.indexOf('DELETE FROM fatedrop_card_source_mappings'));
 assert.doesNotMatch(sql,/DELETE FROM fatedrop_card_identities/);
});
