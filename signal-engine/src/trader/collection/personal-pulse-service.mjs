import { listVerifiedCardsByIdsFromStore } from '../catalogue/store.mjs';
import { getFatePricesFromStore } from '../value/fate-price-service.mjs';
import { listCollectionItemsFromStore } from './store.mjs';
import { buildFateCollectorPersonalPulse } from './personal-pulse.mjs';

function requireText(value,field){
  if(typeof value!=='string'||value.trim()==='')throw new TypeError(`${field} is required`);
  return value.trim();
}

function activeIds(items){
  return [...new Set((Array.isArray(items)?items:[])
    .filter((item)=>item&&item.status!=='removed'&&Number(item.quantity??1)>0)
    .map((item)=>String(item.fateCardId||'').trim())
    .filter(Boolean))];
}

async function pricesForIds(store,ids,{currencyCode,now}){
  const prices=[];
  for(let index=0;index<ids.length;index+=100){
    const batch=ids.slice(index,index+100);
    if(!batch.length)continue;
    prices.push(...await getFatePricesFromStore(store,{cardIdentityIds:batch,currencyCode,now}));
  }
  return prices;
}

export async function getFateCollectorPersonalPulseFromStore(store,{
  userId,
  currencyCode='EUR',
  limit=3,
  now=Date.now(),
}={}){
  const ownerId=requireText(userId,'userId');
  const currency=requireText(currencyCode,'currencyCode').toUpperCase();
  const collectionItems=await listCollectionItemsFromStore(store,{userId:ownerId,limit:2000});
  const ids=activeIds(collectionItems);
  if(!ids.length){
    return buildFateCollectorPersonalPulse({collectionItems,cards:[],prices:[],limit});
  }
  const cards=await listVerifiedCardsByIdsFromStore(store,ids,{limit:2000});
  const verifiedIds=[...new Set(cards.map((card)=>String(card.fateCardId??card.id??'').trim()).filter(Boolean))];
  const prices=verifiedIds.length?await pricesForIds(store,verifiedIds,{currencyCode:currency,now}):[];
  return buildFateCollectorPersonalPulse({collectionItems,cards,prices,limit});
}
