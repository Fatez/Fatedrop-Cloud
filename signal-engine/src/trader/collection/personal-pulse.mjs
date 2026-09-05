import { FATE_PRICE_MOVEMENT_POLICY } from '../value/fate-price.mjs';

function text(value){return typeof value==='string'?value.trim():'';}
function finite(value){return Number.isFinite(value)?Number(value):null;}

function activeQuantities(collectionItems){
  const quantities=new Map();
  for(const item of Array.isArray(collectionItems)?collectionItems:[]){
    if(!item||item.status==='removed')continue;
    const id=text(item.fateCardId);
    const quantity=Number(item.quantity??1);
    if(!id||!Number.isFinite(quantity)||quantity<=0)continue;
    quantities.set(id,(quantities.get(id)||0)+quantity);
  }
  return quantities;
}

function publicMover(card,price,movement,quantity){
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
    currentPrice:finite(price.price?.amount),
    currencyCode:price.price?.currencyCode??null,
    movementAmount:finite(movement?.absolute),
    movementPercent:finite(movement?.percent),
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
  return Object.freeze({
    status:eligible.length?'available':'building',
    reason:eligible.length?null:'owned_price_history_insufficient',
    eligibleOwnedIdentities:eligible.length,
    risers:Object.freeze(risers),
    decliners:Object.freeze(decliners),
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
