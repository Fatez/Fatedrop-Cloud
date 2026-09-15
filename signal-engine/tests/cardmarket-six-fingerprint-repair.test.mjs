import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSixFingerprintRepair } from '../src/trader/value/cardmarket-six-fingerprint-repair.mjs';
import { marketObservationFromPostgres, normaliseMarketObservationCandidate } from '../src/trader/value/market-observation.mjs';
import { compareObservation } from '../src/trader/value/cardmarket-observation-conflict-audit-cli.mjs';

const manifest=JSON.parse(await readFile(new URL('../evidence/cardmarket-six-observation-fingerprints-2026-09-15.json',import.meta.url),'utf8'));

test('all 27 historical fingerprints are proven stale-owner checksums with unchanged source evidence',()=>{
  const repair=buildSixFingerprintRepair(manifest);
  assert.equal(repair.count,27);
  for(const {row,expectedFingerprint} of repair.repairs){
    const corrected=marketObservationFromPostgres(row);
    assert.equal(corrected.id,row.id);
    assert.equal(corrected.contentFingerprint,expectedFingerprint);
    assert.notEqual(expectedFingerprint,row.content_fingerprint);
    assert.deepEqual(compareObservation(row,corrected).changes,[]);
    assert.equal(compareObservation({...row,content_fingerprint:expectedFingerprint},corrected).storedFingerprintMatchesPayload,true);
    assert.deepEqual(corrected.rawPayload,row.raw_payload);
  }
});

test('repair fails closed for modified evidence, owner, finish, checksum, missing or repeated rows',()=>{
  const mutations=[
    m=>{m.rows[0].low_price='999999';},
    m=>{m.rows[0].raw_payload.avg=999999;},
    m=>{m.rows[0].card_identity_id='unknown';},
    m=>{m.rows[0].source_variant_key='reverse';},
    m=>{m.rows[0].content_fingerprint='unknown';},
    m=>{m.rows.pop();},
    m=>{m.rows[1]=m.rows[0];},
  ];
  for(const mutate of mutations){const changed=structuredClone(manifest);mutate(changed);assert.throws(()=>buildSixFingerprintRepair(changed));}
});

test('ownership changes require a new fingerprint while keeping observation identity and price history',()=>{
  const original=marketObservationFromPostgres(manifest.rows[0]);
  const moved=normaliseMarketObservationCandidate({...original,cardIdentityId:'different-card',cardSourceMappingId:'different-mapping'});
  assert.equal(moved.id,original.id);
  assert.notEqual(moved.contentFingerprint,original.contentFingerprint);
  for(const key of ['sourceSnapshotId','sourceRecordId','sourceVariantKey','observedAt','sourceEffectiveAt','lowPrice','trendPrice','rawPayload']) assert.deepEqual(moved[key],original[key]);
});
