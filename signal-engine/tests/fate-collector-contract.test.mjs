import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFateCollectorSetDetail, compactFateCollectorSummaryResponse } from '../src/trader/collection/collector-contract.mjs';

function move(percentChange){return{status:'available',reason:null,currencyCode:'GBP',amountChange:percentChange,percentChange,currentValue:10,baselineValue:10,currentAsOf:2,baselineAsOf:1};}

function result(){
  const cards=[
    {fateCardId:'expensive',printingId:'p2',collectorNumber:'2',name:'Expensive',priceStatus:'available',fatePrice:{amount:20,currencyCode:'GBP'}},
    {fateCardId:'cheap',printingId:'p1',collectorNumber:'1',name:'Cheap',priceStatus:'available',fatePrice:{amount:5,currencyCode:'GBP'}},
    {fateCardId:'unknown',printingId:'p3',collectorNumber:'3',name:'Unknown',priceStatus:'unavailable',fatePrice:null},
  ];
  const set={setId:'set',setName:'Set',tcgCode:'pokemon',status:'available',ownedCount:7,totalCount:10,missingCount:3,completionPercent:70,catalogue:{status:'complete'},value:{status:'available',missingValue:25},missingCards:cards};
  return{
    contractVersion:1,status:'available',reason:null,evidence:{},
    summary:{
      currencyCode:'GBP',collection:{totalValue:100},cardUnits:7,setsOwned:1,progressAvailableSetCount:1,unavailableSetCount:0,
      closestSet:{setId:'set'},games:[{tcgCode:'pokemon',collection:{totalValue:100},cardUnits:7,setsOwned:1,progressAvailableSetCount:1,unavailableSetCount:0,closestSet:{setId:'set'},sets:[set]}],
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

test('set detail can sort missing cards by number and current price',()=>{
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
