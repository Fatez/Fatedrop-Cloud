import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLedger } from '../src/trader/value/english-pricing-blocker-ledger-cli.mjs';
const identity = { cardIdentityId:'a',setId:'s',setName:'Set',variantCode:'holo' };
test('collision overrides preliminary safe status and accounts for the whole queue',()=>{
 const r=reconcileLedger({candidates:[],collisionRows:[identity],resolutions:[{identity,status:'PRE_BATCH_SAFE'}]},{rows:[]},['a']);
 assert.equal(r.rows[0].reason,'HOLD_BATCH_SOURCE_COLLISION'); assert.equal(r.counts.total,1);
});
test('low-only diagnostics cannot become central-price candidates',()=>{
 const r=reconcileLedger({candidates:[],collisionRows:[],resolutions:[]},{rows:[{...identity,classification:'current_target_lane_priceable',currentProviderRow:{trendHolo:null,avg1Holo:0}}]},['a']);
 assert.equal(r.rows[0].reason,'NO_SUPPORTED_CENTRAL_PRICE');
});
test('missing and duplicated identities fail reconciliation',()=>{
 assert.throws(()=>reconcileLedger({candidates:[],collisionRows:[],resolutions:[]},{rows:[]},['a']),/every/);
 assert.throws(()=>reconcileLedger({candidates:[],collisionRows:[],resolutions:[{identity,status:'held'},{identity,status:'held'}]},{rows:[]},['a']),/duplicate/);
});
test('excluded resolution states do not inflate eligible queue',()=>{
 const r=reconcileLedger({candidates:[],collisionRows:[],resolutions:[]},{rows:[identity]},[]);
 assert.equal(r.counts.total,0);
});
