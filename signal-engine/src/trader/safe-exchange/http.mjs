import { resolveFateTraderSessionUser } from '../auth.mjs';
import { resolveFateTraderFlags } from '../feature-flags.mjs';
import {
  actOnSafeExchangeInStore,
  approveFateHubInStore,
  createSafeExchangeInStore,
  getSafeExchangeFromStore,
  issueHubSessionInStore,
  listSafeExchangesFromStore,
} from './store.mjs';

function json(res,status,payload){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});
  res.end(JSON.stringify(payload));
}
function meta(){return{requestId:null,apiVersion:'v1'};}
function ok(res,data,status=200){json(res,status,{ok:true,data,meta:meta()});}
function fail(res,status,code,message,{retryable=false,details={}}={}){json(res,status,{ok:false,error:{code,message,retryable,details},meta:meta()});}
async function readBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('REQUEST_TOO_LARGE');}return raw?JSON.parse(raw):{};}
function internalAuthorized(req,secret){return Boolean(secret)&&req.headers?.['x-fatedrop-secret']===secret;}
function decode(value){try{return decodeURIComponent(value);}catch{return value;}}

const ACTION_ROUTES=Object.freeze({
  agree:'agree',
  'check-in':'check_in',
  dispatch:'dispatch',
  delivered:'delivered',
  inspect:'inspect',
  'begin-confirmation':'begin_confirmation',
  confirm:'confirm',
  cancel:'cancel',
});

function exchangeId(pathname){return pathname.match(/^\/v1\/trader\/exchanges\/([^/]+)$/)?.[1]||null;}
function exchangeAction(pathname){
  const match=pathname.match(/^\/v1\/trader\/exchanges\/([^/]+)\/([^/]+)$/);
  if(!match)return null;
  const action=ACTION_ROUTES[match[2]];
  return action?{exchangeId:decode(match[1]),action}:null;
}
function internalHub(pathname){
  const session=pathname.match(/^\/internal\/trader\/hubs\/([^/]+)\/sessions$/);
  if(session)return{type:'session',hubId:decode(session[1])};
  const approval=pathname.match(/^\/internal\/trader\/hubs\/([^/]+)\/approve$/);
  if(approval)return{type:'approve',hubId:decode(approval[1])};
  return null;
}

export function isFateTraderSafeExchangePath(pathname){
  return pathname==='/v1/trader/exchanges'
    ||/^\/v1\/trader\/exchanges\/[^/]+$/.test(pathname)
    ||/^\/v1\/trader\/exchanges\/[^/]+\/(agree|check-in|dispatch|delivered|inspect|begin-confirmation|confirm|cancel)$/.test(pathname)
    ||/^\/internal\/trader\/hubs\/[^/]+\/(sessions|approve)$/.test(pathname);
}

export async function handleFateTraderSafeExchange(req,res,{
  store,
  flags=resolveFateTraderFlags(),
  resolveUser=resolveFateTraderSessionUser,
  internalSecret='',
}={}){
  const url=new URL(req.url||'/',`http://${req.headers?.host||'localhost'}`);
  if(!isFateTraderSafeExchangePath(url.pathname))return false;
  if(!flags.enabled||!flags.trustEnabled||!flags.safeExchangeEnabled){fail(res,404,'NOT_FOUND','Safe Exchange is not enabled.');return true;}

  try{
    const hubRoute=internalHub(url.pathname);
    if(hubRoute){
      if(!internalAuthorized(req,internalSecret)){fail(res,401,'UNAUTHORIZED','Internal authorization required.');return true;}
      if(req.method!=='POST'){fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed.');return true;}
      const body=await readBody(req);
      if(hubRoute.type==='approve'){
        const hub=await approveFateHubInStore(store,{hubId:hubRoute.hubId,approvedBy:String(body.approvedBy||'internal')});
        ok(res,{hub},201);return true;
      }
      const proof=await issueHubSessionInStore(store,{exchangeId:String(body.exchangeId||''),hubId:hubRoute.hubId,ttlMs:body.ttlMs});
      ok(res,{proof},201);return true;
    }

    const user=await resolveUser(store,req);
    if(!user?.id){fail(res,401,'AUTH_REQUIRED','A valid FateDrop session is required.');return true;}

    if(url.pathname==='/v1/trader/exchanges'){
      if(req.method==='GET'){
        const limit=Math.max(1,Math.min(100,Number.parseInt(url.searchParams.get('limit')||'50',10)||50));
        const exchanges=await listSafeExchangesFromStore(store,{userId:user.id,limit});
        ok(res,{exchanges,count:exchanges.length});return true;
      }
      if(req.method==='POST'){
        const body=await readBody(req);
        const exchange=await createSafeExchangeInStore(store,{userId:user.id,input:body});
        ok(res,{exchange},201);return true;
      }
      fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed.');return true;
    }

    const id=exchangeId(url.pathname);
    if(id){
      if(req.method!=='GET'){fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed.');return true;}
      const exchange=await getSafeExchangeFromStore(store,{userId:user.id,exchangeId:decode(id)});
      if(!exchange)fail(res,404,'SAFE_EXCHANGE_NOT_FOUND','Safe Exchange not found.');else ok(res,{exchange});
      return true;
    }

    const actionRoute=exchangeAction(url.pathname);
    if(actionRoute){
      if(req.method!=='POST'){fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed.');return true;}
      const body=await readBody(req);
      const exchange=await actOnSafeExchangeInStore(store,{userId:user.id,exchangeId:actionRoute.exchangeId,action:actionRoute.action,body});
      ok(res,{exchange});return true;
    }

    return false;
  }catch(error){
    if(error?.message==='REQUEST_TOO_LARGE'){fail(res,413,'REQUEST_TOO_LARGE','Request body is too large.');return true;}
    if(error instanceof SyntaxError){fail(res,400,'INVALID_JSON','Request body is not valid JSON.');return true;}
    if(error?.code==='SAFE_EXCHANGE_NOT_FOUND'){fail(res,404,'SAFE_EXCHANGE_NOT_FOUND','Safe Exchange not found.');return true;}
    if(error?.code==='FTR01'){
      fail(res,409,'COMMITMENT_RESERVED','One or more committed card quantities are already reserved by another active Safe Exchange.');return true;
    }
    if(error?.code==='FTR02'){
      fail(res,409,'COMMITMENT_STALE','One or more committed collection items are no longer available to this exchange.');return true;
    }
    if(['PARTY_NOT_FOUND','COMMITMENT_NOT_OWNED','COMMITMENT_CARD_MISMATCH','COMMITMENT_QUANTITY_UNAVAILABLE','HUB_NOT_APPROVED','HUB_LOCATION_NOT_VERIFIED'].includes(error?.code)){
      fail(res,409,error.code,error.message,{details:error.details||{}});return true;
    }
    if(['HUB_PROOF_INVALID','HUB_SESSION_NOT_ALLOWED','TRANSITION_NOT_ALLOWED'].includes(error?.code)){
      fail(res,409,error.code,error.message,{details:error.details||{}});return true;
    }
    if(error instanceof TypeError){fail(res,400,error.code||'INVALID_SAFE_EXCHANGE_INPUT',error.message,{details:error.details||{}});return true;}
    throw error;
  }
}
