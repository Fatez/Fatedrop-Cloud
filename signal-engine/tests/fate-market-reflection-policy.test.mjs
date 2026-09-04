import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FATEDROP_MARKET_STANCE,
  computeObservedPricePosition,
  toPublicKnownPrice,
} from '../src/trader/value/market-reflection-policy.mjs';

test('public Known Price hides internal pricing quality and provenance fields',()=>{
  const price=toPublicKnownPrice({
    status:'available',
    amount:42.8,
    currencyCode:'GBP',
    sourceEffectiveAt:123,
    confidence:'high',
    providerPolicyKey:'cardmarket-public-download',
    metricUsed:'trendPrice',
  });
  assert.deepEqual(price,{kind:'known_price',amount:42.8,currencyCode:'GBP',asOf:123});
  assert.equal('confidence' in price,false);
  assert.equal('providerPolicyKey' in price,false);
  assert.equal('metricUsed' in price,false);
});

test('market position is descriptive only and never emits financial advice',()=>{
  const result=computeObservedPricePosition({
    observedPrice:34.99,
    referencePrice:42.8,
    currencyCode:'GBP',
    referenceKind:'fair_price',
  });
  assert.equal(result.position,'below_reference');
  assert.equal(result.percentDifference,-18.25);
  assert.equal(result.stance,'observational_only');
  const serialized=JSON.stringify(result).toLowerCase();
  for(const prohibited of ['buy','sell','recommend','opportunity','prediction','forecast']){
    assert.equal(serialized.includes(prohibited),false,`market position must not emit ${prohibited} language`);
  }
});

test('locked stance forbids advice, forecasts and recommendations',()=>{
  assert.equal(FATEDROP_MARKET_STANCE.mode,'observational_only');
  assert.equal(FATEDROP_MARKET_STANCE.financialAdvice,false);
  assert.equal(FATEDROP_MARKET_STANCE.forecasts,false);
  assert.equal(FATEDROP_MARKET_STANCE.recommendations,false);
});
