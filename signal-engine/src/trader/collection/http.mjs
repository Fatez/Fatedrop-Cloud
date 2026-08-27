import { resolveFateTraderFlags } from '../feature-flags.mjs';
import { resolveFateTraderSessionUser } from '../auth.mjs';
import {
  addCollectionMediaReference,
  createCollectionItemInStore,
  listCollectionItemsFromStore,
  listExactWantsFromStore,
  removeCollectionItemFromStore,
  removeExactWantFromStore,
  updateCollectionItemInStore,
  upsertExactWantInStore,
} from './store.mjs';

function json(res,status,payload){
  res.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'access-control-allow-origin':'*',
  });
  res.end(JSON.stringify(payload));
}
function meta(){return{requestId:null,apiVersion:'v1'};}
function ok(res,data,status=200){json(res,status,{ok:true,data,meta:meta()});}
function fail(res,status,code,message,{retryable=false,details={}}={}){json(res,status,{ok:false,error:{code,message,retryable,details},meta:meta()});}
async function readBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('REQUEST_TOO_LARGE');}return raw?JSON.parse(raw):{};}
function itemId(pathname){return pathname.match(/^\/v1\/collection\/items\/([^/]+)$/)?.[1]||null;}
function wantId(pathname){return pathname.match(/^\/v1\/wants\/([^/]+)$/)?.[1]||null;}
function mediaItemId(pathname){return pathname.match(/^\/v1\/collection\/items\/([^/]+)\/media$/)?.[1]||null;}

export function isFateTraderCollectionPath(pathname){
  return pathname==='/v1/collection'
    ||pathname==='/v1/collection/items'
    ||/^\/v1\/collection\/items\/[^/]+$/.test(pathname)
    ||/^\/v1\/collection\/items\/[^/]+\/media$/.test(pathname)
    ||pathname==='/v1/wants'
    ||/^\/v1\/wants\/[^/]+$/.test(pathname);
}

export async function handleFateTraderCollection(req,res,{
  store,
  flags=resolveFateTraderFlags(),
  resolveUser=resolveFateTraderSessionUser,
}={}){
  const url=new URL(req.url||'/',`http://${req.headers?.host||'localhost'}`);
  if(!isFateTraderCollectionPath(url.pathname))return false;
  if(!flags.enabled||!flags.catalogueEnabled||!flags.collectionEnabled){
    fail(res,404,'NOT_FOUND','Collection resource not found.');return true;
  }
  const user=await resolveUser(store,req);
  if(!user?.id){fail(res,401,'AUTH_REQUIRED','A valid FateDrop session is required.');return true;}

  try{
    if(req.method==='GET'&&url.pathname==='/v1/collection'){
      const [items,wants]=await Promise.all([
        listCollectionItemsFromStore(store,{userId:user.id,limit:Math.min(2000,Math.max(1,Number.parseInt(url.searchParams.get('limit')||'500',10)||500))}),
        listExactWantsFromStore(store,{userId:user.id,limit:1000}),
      ]);
      ok(res,{items,wants,summary:{ownedLots:items.length,totalCopies:items.reduce((sum,item)=>sum+item.quantity,0),tradeableCopies:items.reduce((sum,item)=>sum+item.tradeQuantity,0),wantedCards:wants.length}});return true;
    }

    if(req.method==='POST'&&url.pathname==='/v1/collection/items'){
      const body=await readBody(req);
      const item=await createCollectionItemInStore(store,{userId:user.id,input:body});
      ok(res,{item},201);return true;
    }

    const collectionItemId=itemId(url.pathname);
    if(collectionItemId&&req.method==='PATCH'){
      const body=await readBody(req);
      const expectedRevision=body.expectedRevision==null?null:Number(body.expectedRevision);
      const item=await updateCollectionItemInStore(store,{userId:user.id,itemId:decodeURIComponent(collectionItemId),input:body,expectedRevision});
      if(!item)fail(res,404,'COLLECTION_ITEM_NOT_FOUND','Collection item not found.');else ok(res,{item});
      return true;
    }
    if(collectionItemId&&req.method==='DELETE'){
      const expected=url.searchParams.get('expectedRevision');
      const removed=await removeCollectionItemFromStore(store,{userId:user.id,itemId:decodeURIComponent(collectionItemId),expectedRevision:expected==null?null:Number(expected)});
      if(!removed)fail(res,404,'COLLECTION_ITEM_NOT_FOUND','Collection item not found.');else ok(res,{removed:true});
      return true;
    }

    const collectionItemForMedia=mediaItemId(url.pathname);
    if(collectionItemForMedia&&req.method==='POST'){
      const body=await readBody(req);
      const media=await addCollectionMediaReference(store,{userId:user.id,itemId:decodeURIComponent(collectionItemForMedia),mediaRole:body.mediaRole,storageKey:body.storageKey});
      if(!media)fail(res,404,'COLLECTION_ITEM_NOT_FOUND','Collection item not found.');else ok(res,{media},201);
      return true;
    }

    if(req.method==='GET'&&url.pathname==='/v1/wants'){
      const wants=await listExactWantsFromStore(store,{userId:user.id});ok(res,{wants,count:wants.length});return true;
    }
    const fateCardId=wantId(url.pathname);
    if(fateCardId&&req.method==='PUT'){
      const body=await readBody(req);
      const want=await upsertExactWantInStore(store,{userId:user.id,fateCardId:decodeURIComponent(fateCardId),input:body});
      ok(res,{want});return true;
    }
    if(fateCardId&&req.method==='DELETE'){
      const removed=await removeExactWantFromStore(store,{userId:user.id,fateCardId:decodeURIComponent(fateCardId)});
      if(!removed)fail(res,404,'WANT_NOT_FOUND','Want not found.');else ok(res,{removed:true});
      return true;
    }

    fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed.');return true;
  }catch(error){
    if(error?.code==='CARD_IDENTITY_NOT_VERIFIED'){fail(res,409,'CARD_IDENTITY_NOT_VERIFIED','The requested card identity is not verified.');return true;}
    if(error?.code==='REVISION_CONFLICT'){fail(res,409,'REVISION_CONFLICT','The collection item changed since it was last read. Refresh and retry.');return true;}
    if(error?.code==='FTR03'){fail(res,409,'COLLECTION_ITEM_RESERVED','This collection item has quantity committed to an active Safe Exchange. Cancel or complete that exchange before reducing the reserved quantity.');return true;}
    if(error?.message==='REQUEST_TOO_LARGE'){fail(res,413,'REQUEST_TOO_LARGE','Request body is too large.');return true;}
    if(error instanceof SyntaxError){fail(res,400,'INVALID_JSON','Request body is not valid JSON.');return true;}
    if(error instanceof TypeError){fail(res,400,'INVALID_COLLECTION_INPUT',error.message);return true;}
    throw error;
  }
}
