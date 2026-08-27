import { resolveFateTraderSessionUser } from '../auth.mjs';
import { resolveFateTraderFlags } from '../feature-flags.mjs';
import { getTrustProfileFromStore, recordTrustEvidenceInStore, trustEvidenceAffectsScore } from './store.mjs';

function json(res,status,payload){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});
  res.end(JSON.stringify(payload));
}
function meta(){return{requestId:null,apiVersion:'v1'};}
function ok(res,data,status=200){json(res,status,{ok:true,data,meta:meta()});}
function fail(res,status,code,message,{retryable=false,details={}}={}){json(res,status,{ok:false,error:{code,message,retryable,details},meta:meta()});}
async function readBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('REQUEST_TOO_LARGE');}return raw?JSON.parse(raw):{};}
function internalAuthorized(req,secret){return Boolean(secret)&&req.headers?.['x-fatedrop-secret']===secret;}

export function isFateTraderTrustPath(pathname){
  return pathname==='/v1/trader/trust/me'||pathname==='/internal/trader/trust/evidence';
}

export async function handleFateTraderTrust(req,res,{
  store,
  flags=resolveFateTraderFlags(),
  resolveUser=resolveFateTraderSessionUser,
  internalSecret='',
}={}){
  const url=new URL(req.url||'/',`http://${req.headers?.host||'localhost'}`);
  if(!isFateTraderTrustPath(url.pathname))return false;
  if(!flags.enabled||!flags.trustEnabled){fail(res,404,'NOT_FOUND','FateTrust is not enabled.');return true;}

  try{
    if(url.pathname==='/v1/trader/trust/me'){
      if(req.method!=='GET'){fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed.');return true;}
      const user=await resolveUser(store,req);
      if(!user?.id){fail(res,401,'AUTH_REQUIRED','A valid FateDrop session is required.');return true;}
      const profile=await getTrustProfileFromStore(store,{userId:user.id});
      if(!profile){fail(res,404,'TRUST_PROFILE_NOT_FOUND','FateTrust profile not found.');return true;}
      ok(res,{profile,notice:'FateTrust is evidence-based. Unknown verification signals remain unknown and do not receive credit.'});return true;
    }

    if(url.pathname==='/internal/trader/trust/evidence'){
      if(!internalAuthorized(req,internalSecret)){fail(res,401,'UNAUTHORIZED','Internal authorization required.');return true;}
      if(req.method!=='POST'){fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed.');return true;}
      const body=await readBody(req);
      const evidence=await recordTrustEvidenceInStore(store,body);
      ok(res,{evidence,affectsScore:trustEvidenceAffectsScore(evidence)},201);return true;
    }

    return false;
  }catch(error){
    if(error?.message==='REQUEST_TOO_LARGE'){fail(res,413,'REQUEST_TOO_LARGE','Request body is too large.');return true;}
    if(error instanceof SyntaxError){fail(res,400,'INVALID_JSON','Request body is not valid JSON.');return true;}
    if(error instanceof TypeError){fail(res,400,'INVALID_TRUST_EVIDENCE',error.message);return true;}
    throw error;
  }
}
