import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcilePinnedFinishEvidence } from '../src/trader/catalogue/primary-finish-evidence.mjs';

const census = cards => ({ format:'fatedrop-primary-source-census-v1', revision:'pinned', cards });
const card = (id, extra={}) => ({ id, setId:'set1', language:'en', englishNamed:true, explicitFinishes:[], firstEdition:false, held:false, digital:false, ...extra });
const snapshot = (payload, extra={}) => ({ schemaVersion:1, namespace:'tcgdex-en', sourceVersion:'tcgdex-en-v1', method:'getCard', argsDigest:'x', payloadDigest:'not-read-here', payload, ...extra });
async function put(root, name, value) { const dir=join(root,'tcgdex-en','tcgdex-en-v1','getCard'); await mkdir(dir,{recursive:true}); await writeFile(join(dir,name+'.json'),JSON.stringify(value)); }

test('reconciles only exact card/set cached API finish evidence', async()=>{
  const root=await mkdtemp(join(tmpdir(),'fd-finish-'));
  await put(root,'one',snapshot({id:'set1-1',set:{id:'set1'},variants:{normal:true,holo:false,reverse:true,firstEdition:false}}));
  await put(root,'wrong-set',snapshot({id:'set1-2',set:{id:'other'},variants:{normal:true,holo:false,reverse:false,firstEdition:false}}));
  const result=await reconcilePinnedFinishEvidence(census([card('set1-1'),card('set1-2')]),{snapshotDirectory:root});
  assert.deepEqual(result.census.cards[0].explicitFinishes,['normal','reverse']);
  assert.equal(result.census.cards[0].finishEvidenceOrigin,'materialized_tcgdex_api_snapshot');
  assert.deepEqual(result.census.cards[1].explicitFinishes,[]);
  assert.equal(result.report.reconciled,1);
  assert.equal(result.report.setMismatch,1);
});

test('never resolves first edition, malformed variants, or conflicting snapshots', async()=>{
  const root=await mkdtemp(join(tmpdir(),'fd-finish-'));
  await put(root,'edition',snapshot({id:'set1-1',set:{id:'set1'},variants:{normal:true,holo:false,reverse:false,firstEdition:true}}));
  await put(root,'malformed',snapshot({id:'set1-2',set:{id:'set1'},variants:{normal:true}}));
  await put(root,'conflict-a',snapshot({id:'set1-3',set:{id:'set1'},variants:{normal:true,holo:false,reverse:false,firstEdition:false}}));
  await put(root,'conflict-b',snapshot({id:'set1-3',set:{id:'set1'},variants:{normal:false,holo:true,reverse:false,firstEdition:false}}));
  const result=await reconcilePinnedFinishEvidence(census([card('set1-1'),card('set1-2'),card('set1-3')]),{snapshotDirectory:root});
  assert.equal(result.report.reconciled,0);
  assert.equal(result.report.conflictingSnapshots,1);
  assert.ok(result.census.cards.every(x=>x.explicitFinishes.length===0));
});

test('does not overwrite raw pinned finish declarations or held/digital records', async()=>{
  const root=await mkdtemp(join(tmpdir(),'fd-finish-'));
  for (const id of ['set1-1','set1-2','set1-3']) await put(root,id,snapshot({id,set:{id:'set1'},variants:{normal:true,holo:true,reverse:true,firstEdition:false}}));
  const result=await reconcilePinnedFinishEvidence(census([
    card('set1-1',{explicitFinishes:['holo']}),
    card('set1-2',{held:true}),
    card('set1-3',{digital:true}),
  ]),{snapshotDirectory:root});
  assert.deepEqual(result.census.cards[0].explicitFinishes,['holo']);
  assert.equal(result.report.rawUnknown,0);
  assert.equal(result.report.reconciled,0);
});
