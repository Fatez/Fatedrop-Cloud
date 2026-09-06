import { FATE_PRICE_MOVEMENT_POLICY } from '../value/fate-price.mjs';

function text(value){return typeof value==='string'?value.trim():'';}
function finite(value){return Number.isFinite(value)?Number(value):null;}

function activeQuantities(collectionItems){
  const quantities=new Map();
  for(const item of Array.isArray(collectionItems)?collectionItems:[]){
    if(!item||item.status==='removed')continue;
    if(String(item.copyState||'raw').toLowerCase()!=='raw')continue;
    const id=text(item.fateCardId);
    const quantity=Number(item.quantity??1);
    if(!id||!Number.isFinite(quantity)||quantity<=0)continue;
    quantities.set(id,(quantities.get(id)||0)+quantity);
  }
  return quantities;
}

function publicMover(card,price,movement,quantity){
  const currentPrice=finite(price.price?.amount);
  const movementPercent=finite(movement?.percent);
  const factor=movementPercent==null?null:1+(movementPercent/100);
  const movementAmount=currentPrice==null||factor==null||factor<=0?null:currentPrice-(currentPrice/factor);
  return Object.freeze({
    cardIdentityId:price.cardIdentityId,
    name:card?.name??null,
    tcgCode:card?.tcgCode??null,
    setId:card?.setId??null,
    setName:card?.setName??null,
    collectorNumber:card?.collectorNumber??null,
    variantCode:card?.variantCode??null,
    languageCode:card?.languageCode??null,
    quantity,
    currentPrice,
    currencyCode:price.price?.currencyCode??null,
    movementAmount:movementAmount==null?null:Number(movementAmount.toFixed(2)),
    movementPercent,
  });
}

function setMovers(eligible,limit){
  const groups=new Map();
  for(const row of eligible){
    const setId=text(row.setId);
    const currentPrice=finite(row.currentPrice);
    const movementPercent=finite(row.movementPercent);
    const factor=movementPercent==null?null:1+(movementPercent/100);
    if(!setId||currentPrice==null||factor==null||factor<=0)continue;
    const group=groups.get(setId)||{
      setId,
      setName:row.setName??null,
      tcgCode:row.tcgCode??null,
      currencyCode:row.currencyCode??null,
      currentValue:0,
      baselineValue:0,
      eligibleOwnedIdentities:0,
      eligibleOwnedCopies:0,
    };
    const currentValue=currentPrice*row.quantity;
    group.currentValue+=currentValue;
    group.baselineValue+=currentValue/factor;
    group.eligibleOwnedIdentities+=1;
    group.eligibleOwnedCopies+=row.quantity;
    groups.set(setId,group);
  }
  const rows=[...groups.values()].map((row)=>{
    const movementAmount=row.currentValue-row.baselineValue;
    return Object.freeze({
      setId:row.setId,
      setName:row.setName,
      tcgCode:row.tcgCode,
      currencyCode:row.currencyCode,
      currentValue:Number(row.currentValue.toFixed(2)),
      baselineValue:Number(row.baselineValue.toFixed(2)),
      movementAmount:Number(movementAmount.toFixed(2)),
      movementPercent:row.baselineValue>0?Number(((movementAmount/row.baselineValue)*100).toFixed(1)):null,
      eligibleOwnedIdentities:row.eligibleOwnedIdentities,
      eligibleOwnedCopies:row.eligibleOwnedCopies,
    });
  });
  return Object.freeze({
    risers:Object.freeze(rows.filter((row)=>Number(row.movementPercent)>0)
      .sort((a,b)=>Number(b.movementPercent)-Number(a.movementPercent)||String(a.setName||'').localeCompare(String(b.setName||''))).slice(0,limit)),
    decliners:Object.freeze(rows.filter((row)=>Number(row.movementPercent)<0)
      .sort((a,b)=>Number(a.movementPercent)-Number(b.movementPercent)||String(a.setName||'').localeCompare(String(b.setName||''))).slice(0,limit)),
  });
}

function periodResult(key,{prices,cardsById,quantities,limit}){
  const eligible=[];
  for(const price of Array.isArray(prices)?prices:[]){
    const id=text(price?.cardIdentityId);
    if(!id||!quantities.has(id)||price?.available!==true)continue;
    const movement=price?.movement?.[key];
    const percent=finite(movement?.percent);
    if(movement?.available!==true||percent==null)continue;
    eligible.push(publicMover(cardsById.get(id),price,movement,quantities.get(id)));
  }
  const risers=eligible
    .filter((row)=>Number(row.movementPercent)>0)
    .sort((a,b)=>Number(b.movementPercent)-Number(a.movementPercent)||String(a.name||'').localeCompare(String(b.name||'')))
    .slice(0,limit);
  const decliners=eligible
    .filter((row)=>Number(row.movementPercent)<0)
    .sort((a,b)=>Number(a.movementPercent)-Number(b.movementPercent)||String(a.name||'').localeCompare(String(b.name||'')))
    .slice(0,limit);
  const sets=setMovers(eligible,limit);
  return Object.freeze({
    status:eligible.length?'available':'building',
    reason:eligible.length?null:'owned_price_history_insufficient',
    eligibleOwnedIdentities:eligible.length,
    risers:Object.freeze(risers),
    decliners:Object.freeze(decliners),
    setRisers:sets.risers,
    setDecliners:sets.decliners,
  });
}

export function buildFateCollectorPersonalPulse({collectionItems=[],cards=[],prices=[],limit=3}={}){
  const safeLimit=Math.max(1,Math.min(10,Number.parseInt(String(limit),10)||3));
  const quantities=activeQuantities(collectionItems);
  const cardsById=new Map((Array.isArray(cards)?cards:[]).map((card)=>[text(card?.fateCardId??card?.id),card]).filter(([id])=>id));
  const verifiedOwned=[...quantities.keys()].filter((id)=>cardsById.has(id));
  return Object.freeze({
    schemaVersion:'collector-personal-pulse:1',
    movementPolicy:FATE_PRICE_MOVEMENT_POLICY,
    ownedIdentityCount:quantities.size,
    verifiedOwnedIdentityCount:verifiedOwned.length,
    periods:Object.freeze({
      d7:periodResult('d7',{prices,cardsById,quantities,limit:safeLimit}),
      d30:periodResult('d30',{prices,cardsById,quantities,limit:safeLimit}),
    }),
  });
}
