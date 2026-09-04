import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFateCollectorSetDetail, compactFateCollectorSummaryResponse } from '../src/trader/collection/collector-contract.mjs';

function move(percentChange){return{status:'available',reason:null,currencyCode:'GBP',amountChange:percentChange,percentChange,currentValue:10,baselineValue:10,currentAsOf:2,baselineAsOf:1};}

function collectionValue({fair=false}={}){
  return{status:'available',reason:null,currencyCode:'GBP',valuationBasis:fair?'fair-price':'known-price',totalUnits:7,pricedUnits:7,fairPricedUnits:fair?7:0,knownPricedUnits:fair?0:7,priceCoveragePercent:100,totalValue:100,fairValue:fair?100:null,knownValue:100};
}

function setValue({fair=false}={}){
  return{
    status:'available',reason:null,currencyCode:'GBP',valuationBasis:fair?'fair-price':'known-price',
    expectedCount:10,pricedCount:10,priceCoveragePercent:100,fullSetValue:150,fairSetValue:fair?150:null,knownSetValue:150,
    ownedExpectedCount:7,ownedPricedCount:7,ownedPriceCoveragePercent:100,ownedValue:125,fairOwnedValue:fair?125:null,knownOwnedValue:125,
    missingExpectedCount:3,missingPricedCount:3,missingPriceCoveragePercent:100,missingValue:25,fairMissingValue:fair?25:null,knownMissingValue:25,
  };
}

function result({fair=false}={}){
  const cards=[
    {fateCardId:'expensive',printingId:'p2',collectorNumber:'2',name:'Expensive',priceStatus:'available',knownPrice:{kind:'known_price',amount:20,currencyCode:'GBP',asOf:2}},
    {fateCardId:'cheap',printingId:'p1',collectorNumber:'1',name:'Cheap',priceStatus:'available',knownPrice:{kind:'known_price',amount:5,currencyCode:'GBP',asOf:2}},
    {fateCardId:'unknown',printingId:'p3',collectorNumber:'3',name:'Unknown',priceStatus:'unavailable',knownPrice:null},
  ];
  const set={setId:'set',setName:'Set',tcgCode:'pokemon',status:'available',ownedCount:7,totalCount:10,missingCount:3,completionPercent:70,catalogue:{status:'complete'},value:setValue({fair}),missingCards:cards};
  return{
    contractVersion:1,status:'available',reason:null,evidence:{},
    summary:{
      currencyCode:'GBP',collection:collectionValue({fair}),cardUnits:7,setsOwned:1,progressAvailableSetCount:1,unavailableSetCount:0,
      closestSet:{setId:'set'},games:[{tcgCode:'pokemon',collection:collectionValue({fair}),cardUnits:7,setsOwned:1,progressAvailableSetCount:1,unavailableSetCount:0,closestSet:{setId:'set'},sets:[set]}],
      sets:[set],
      movement:{schemaVersion:1,basis:'current-holdings-repriced',currencyCode:'GBP',currentAsOf:2,
        sevenDay:{status:'available',baselineAsOf:1,collection:move(1),games:[],sets:[{setId:'set',setName:'Set',tcgCode:'pokemon',value:{fullSet:move(1),owned:move(1),missing:move(1)},missingCards:[
          {fateCardId:'expensive',printingId:'p2',movement:move(-2)},
          {fateCardId:'cheap',printingId:'p1',movement:move(3)},
          {fateCardId:'unknown',printingId:'p3',movement:{status:'unavailable',percentChange:null}},
        ]}]},
        thirtyDay:{status:'available',baselineAsOf:0,collection:move(2),games:[],sets:[{setId:'set',setName:'Set',tcgCode:'pokemon',value:{fullSet:move(2),owned:move(2),missing:move(2)},missingCards:[
          {fateCardId:'expensive',printingId:'p2',movement:move(-10)},
          {fateCardId:'cheap',printingId:'p1',movement:move(5)},
          {fateCardId:'unknown',printingId:'p3',movement:{status:'unavailable',percentChange:null}},
        ]}]},
      },
    },
  };
}

test('compact summary strips heavy per-set missing-card payloads and duplicate game set arrays',()=>{
  const compact=compactFateCollectorSummaryResponse(result());
  assert.equal(compact.summary.sets.length,1);
  assert.equal('missingCards' in compact.summary.sets[0],false);
  assert.equal('sets' in compact.summary.games[0],false);
  assert.equal('missingCards' in compact.summary.movement.thirtyDay.sets[0],false);
});

test('public summary labels raw complete valuation as Known Value, not Fair Value',()=>{
  const compact=compactFateCollectorSummaryResponse(result());
  assert.deepEqual(compact.summary.collection,{status:'available',reason:null,kind:'known_value',amount:100,currencyCode:'GBP',coveragePercent:100});
  assert.equal(compact.summary.sets[0].value.fullSet.kind,'known_value');
  assert.equal(compact.summary.sets[0].value.fullSet.amount,150);
});

test('public summary only uses Fair Value label when underlying valuation is fully Fair Price based',()=>{
  const compact=compactFateCollectorSummaryResponse(result({fair:true}));
  assert.equal(compact.summary.collection.kind,'fair_value');
  assert.equal(compact.summary.collection.amount,100);
  assert.equal(compact.summary.sets[0].value.fullSet.kind,'fair_value');
  assert.equal(compact.summary.sets[0].value.owned.kind,'fair_value');
  assert.equal(compact.summary.sets[0].value.missing.kind,'fair_value');
});

test('set detail can sort missing cards by number and Known Price',()=>{
  const byNumber=buildFateCollectorSetDetail(result(),{setId:'set',sort:'number'});
  assert.deepEqual(byNumber.set.missingCards.map((card)=>card.fateCardId),['cheap','expensive','unknown']);
  const cheapest=buildFateCollectorSetDetail(result(),{setId:'set',sort:'cheapest'});
  assert.deepEqual(cheapest.set.missingCards.map((card)=>card.fateCardId),['cheap','expensive','unknown']);
  const expensive=buildFateCollectorSetDetail(result(),{setId:'set',sort:'most_expensive'});
  assert.deepEqual(expensive.set.missingCards.map((card)=>card.fateCardId),['expensive','cheap','unknown']);
});

test('Price Falling sorts by each missing card 30D movement and leaves unknown movement last',()=>{
  const falling=buildFateCollectorSetDetail(result(),{setId:'set',sort:'price_falling'});
  assert.deepEqual(falling.set.missingCards.map((card)=>card.fateCardId),['expensive','cheap','unknown']);
  assert.equal(falling.set.missingCards[0].movement.thirtyDay.percentChange,-10);
  assert.equal(falling.set.missingCards[1].movement.thirtyDay.percentChange,5);
  assert.equal(falling.set.missingCards[2].movement.thirtyDay.percentChange,null);
});

test('consumer price contract contains no confidence or provider-policy internals',()=>{
  const detail=buildFateCollectorSetDetail(result(),{setId:'set'});
  const price=detail.set.missingCards[0].knownPrice;
  assert.deepEqual(Object.keys(price).sort(),['amount','asOf','currencyCode','kind']);
  assert.equal('confidence' in price,false);
  assert.equal('providerPolicyKey' in price,false);
  assert.equal('metricUsed' in price,false);
});
