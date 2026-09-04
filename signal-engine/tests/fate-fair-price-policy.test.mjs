import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAIR_PRICE_METHODOLOGIES,
  assertFairPriceMethodologyApproved,
  publishFairPriceCandidate,
} from '../src/trader/value/fair-price-policy.mjs';

test('Fair Price V1 remains closed until methodology is calibrated and explicitly enabled',()=>{
  assert.equal(FAIR_PRICE_METHODOLOGIES['fair-price-v1'].status,'research');
  assert.equal(FAIR_PRICE_METHODOLOGIES['fair-price-v1'].consumerEnabled,false);
  assert.throws(
    ()=>assertFairPriceMethodologyApproved('fair-price-v1'),
    (error)=>error?.code==='FAIR_PRICE_NOT_CALIBRATED',
  );
});

test('raw market evidence cannot be relabelled as Fair Price through the publication gate',()=>{
  assert.throws(()=>publishFairPriceCandidate({
    methodologyKey:'fair-price-v1',
    cardIdentityId:'card_1',
    amount:42.8,
    currencyCode:'GBP',
    asOf:100,
    sourceName:'cardmarket',
    valuationKind:'raw-market',
  }),(error)=>error?.code==='FAIR_PRICE_NOT_CALIBRATED');
});

test('unknown Fair Price methodology fails closed',()=>{
  assert.throws(
    ()=>assertFairPriceMethodologyApproved('made-up-method'),
    (error)=>error?.code==='FAIR_PRICE_METHODOLOGY_UNKNOWN',
  );
});
