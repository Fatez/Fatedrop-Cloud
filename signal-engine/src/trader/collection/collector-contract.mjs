function text(value){return value==null?'':String(value).trim();}

function compactSet(set){
  if(!set)return null;
  return Object.freeze({
    setId:set.setId,
    setName:set.setName??null,
    tcgCode:set.tcgCode??null,
    status:set.status,
    reason:set.reason??null,
    ownedCount:set.ownedCount??null,
    totalCount:set.totalCount??null,
    missingCount:set.missingCount??null,
    completionPercent:set.completionPercent??null,
    value:set.value??null,
  });
}

function compactGame(game){
  return Object.freeze({
    tcgCode:game.tcgCode,
    collection:game.collection,
    cardUnits:game.cardUnits,
    setsOwned:game.setsOwned,
    progressAvailableSetCount:game.progressAvailableSetCount,
    unavailableSetCount:game.unavailableSetCount,
    closestSet:game.closestSet,
  });
}

function compactMovementWindow(window){
  if(!window)return null;
  return Object.freeze({
    status:window.status,
    reason:window.reason??null,
    baselineAsOf:window.baselineAsOf??null,
    collection:window.collection,
    games:Object.freeze((window.games||[]).map((game)=>Object.freeze({tcgCode:game.tcgCode,collection:game.collection}))),
    sets:Object.freeze((window.sets||[]).map((set)=>Object.freeze({
      setId:set.setId,setName:set.setName??null,tcgCode:set.tcgCode??null,value:set.value,
    }))),
  });
}

export function compactFateCollectorSummaryResponse(result){
  if(!result||typeof result!=='object')throw new TypeError('collector result is required');
  const summary=result.summary;
  if(!summary)return result;
  return Object.freeze({
    ...result,
    summary:Object.freeze({
      currencyCode:summary.currencyCode,
      collection:summary.collection,
      cardUnits:summary.cardUnits,
      setsOwned:summary.setsOwned,
      progressAvailableSetCount:summary.progressAvailableSetCount,
      unavailableSetCount:summary.unavailableSetCount,
      closestSet:summary.closestSet,
      games:Object.freeze((summary.games||[]).map(compactGame)),
      sets:Object.freeze((summary.sets||[]).map(compactSet)),
      movement:Object.freeze({
        schemaVersion:summary.movement?.schemaVersion??1,
        basis:summary.movement?.basis??'current-holdings-repriced',
        currencyCode:summary.movement?.currencyCode??summary.currencyCode,
        currentAsOf:summary.movement?.currentAsOf??null,
        sevenDay:compactMovementWindow(summary.movement?.sevenDay),
        thirtyDay:compactMovementWindow(summary.movement?.thirtyDay),
      }),
    }),
  });
}

function movementSet(window,setId){
  return (window?.sets||[]).find((set)=>set.setId===setId)??null;
}

function missingMovementIndex(setMovement){
  return new Map((setMovement?.missingCards||[]).map((card)=>[card.printingId??card.fateCardId,card.movement]));
}

function numberKey(card){
  const raw=text(card?.collectorNumber);
  const numeric=raw.match(/^\d+$/)?Number(raw):null;
  return{raw,numeric};
}

function compareNumber(a,b){
  const ak=numberKey(a);const bk=numberKey(b);
  if(ak.numeric!=null&&bk.numeric!=null&&ak.numeric!==bk.numeric)return ak.numeric-bk.numeric;
  if(ak.numeric!=null&&bk.numeric==null)return-1;
  if(ak.numeric==null&&bk.numeric!=null)return 1;
  return ak.raw.localeCompare(bk.raw,undefined,{numeric:true});
}

function price(card){const value=Number(card?.fatePrice?.amount);return Number.isFinite(value)?value:null;}
function falling(card){const value=Number(card?.movement?.thirtyDay?.percentChange);return Number.isFinite(value)?value:null;}

function sortMissing(cards,sort){
  const mode=text(sort).toLowerCase()||'number';
  const rows=[...cards];
  if(mode==='cheapest')return rows.sort((a,b)=>{
    const av=price(a),bv=price(b);if(av==null&&bv==null)return compareNumber(a,b);if(av==null)return 1;if(bv==null)return-1;return av-bv||compareNumber(a,b);
  });
  if(mode==='most_expensive'||mode==='expensive')return rows.sort((a,b)=>{
    const av=price(a),bv=price(b);if(av==null&&bv==null)return compareNumber(a,b);if(av==null)return 1;if(bv==null)return-1;return bv-av||compareNumber(a,b);
  });
  if(mode==='price_falling'||mode==='falling')return rows.sort((a,b)=>{
    const av=falling(a),bv=falling(b);if(av==null&&bv==null)return compareNumber(a,b);if(av==null)return 1;if(bv==null)return-1;return av-bv||compareNumber(a,b);
  });
  return rows.sort(compareNumber);
}

export function buildFateCollectorSetDetail(result,{setId,sort='number'}={}){
  if(!result?.summary)throw new TypeError('collector result summary is required');
  const canonicalSetId=text(setId);
  if(!canonicalSetId)throw new TypeError('setId is required');
  const set=(result.summary.sets||[]).find((row)=>row.setId===canonicalSetId);
  if(!set)return null;
  const seven=movementSet(result.summary.movement?.sevenDay,canonicalSetId);
  const thirty=movementSet(result.summary.movement?.thirtyDay,canonicalSetId);
  const sevenMissing=missingMovementIndex(seven);
  const thirtyMissing=missingMovementIndex(thirty);
  const missingCards=(set.missingCards||[]).map((card)=>{
    const key=card.printingId??card.fateCardId;
    return Object.freeze({
      ...card,
      movement:Object.freeze({
        sevenDay:sevenMissing.get(key)??null,
        thirtyDay:thirtyMissing.get(key)??null,
      }),
    });
  });

  return Object.freeze({
    contractVersion:1,
    status:set.status,
    reason:set.reason??null,
    set:Object.freeze({
      ...compactSet(set),
      catalogue:set.catalogue??null,
      missingCards:Object.freeze(sortMissing(missingCards,sort)),
    }),
    movement:Object.freeze({
      basis:result.summary.movement?.basis??'current-holdings-repriced',
      sevenDay:seven?Object.freeze({status:result.summary.movement?.sevenDay?.status??'unavailable',baselineAsOf:result.summary.movement?.sevenDay?.baselineAsOf??null,value:seven.value}):null,
      thirtyDay:thirty?Object.freeze({status:result.summary.movement?.thirtyDay?.status??'unavailable',baselineAsOf:result.summary.movement?.thirtyDay?.baselineAsOf??null,value:thirty.value}):null,
    }),
    sort:text(sort).toLowerCase()||'number',
  });
}
