import { resolveFateTraderSessionUser } from '../auth.mjs';
import { resolveFateTraderFlags } from '../feature-flags.mjs';
import { getFateCollectorSummaryFromStore } from './collector-summary-service.mjs';
import { confirmCollectrImportFromStore } from './import/confirmation.mjs';
import { previewCollectrImportFromStore } from './import/preview.mjs';
import { getCollectionSetProgressFromStore } from './progress-service.mjs';

const SUMMARY_PATH='/v1/collectors/summary';
const PREVIEW_PATH='/v1/collectors/import/collectr/preview';
const CONFIRM_PATH='/v1/collectors/import/collectr/confirm';

function json(res,status,payload){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});res.end(JSON.stringify(payload));}
function meta(){return{requestId:null,apiVersion:'v1'};}
function ok(res,data,status=200){json(res,status,{ok:true,data,meta:meta()});}
function fail(res,status,code,message,{retryable=false,details={}}={}){json(res,status,{ok:false,error:{code,message,retryable,details},meta:meta()});}
async function readBody(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2_000_000)throw new Error('REQUEST_TOO_LARGE');}return raw?JSON.parse(raw):{};}
function progressSetId(pathname){return pathname.match(/^\/v1\/collectors\/sets\/([^/]+)\/progress$/)?.[1]||null;}

export function isFateCollectorsPath(pathname){
  return pathname===SUMMARY_PATH||pathname===PREVIEW_PATH||pathname===CONFIRM_PATH||/^\/v1\/collectors\/sets\/[^/]+\/progress$/.test(pathname);
}

export async function handleFateCollectors(req,res,{store,flags=resolveFateTraderFlags(),resolveUser=resolveFateTraderSessionUser}={}){
  const url=new URL(req.url||'/',`http://${req.headers?.host||'localhost'}`);
  if(!isFateCollectorsPath(url.pathname))return false;
  if(!flags.enabled||!flags.catalogueEnabled||!flags.collectionEnabled){fail(res,404,'NOT_FOUND','Fate Collectors resource not found.');return true;}
  const user=await resolveUser(store,req);
  if(!user?.id){fail(res,401,'AUTH_REQUIRED','A valid FateDrop session is required.');return true;}

  try{
    if(req.method==='GET'&&url.pathname===SUMMARY_PATH){
      const currencyCode=String(url.searchParams.get('currency')||'EUR').trim().toUpperCase();
      const preferredLanguageCode=String(url.searchParams.get('language')||'en').trim().toLowerCase();
      const preferredVariantCode=String(url.searchParams.get('variant')||'standard').trim().toLowerCase();
      const summary=await getFateCollectorSummaryFromStore(store,{userId:user.id,currencyCode,preferredLanguageCode,preferredVariantCode});
      ok(res,summary);return true;
    }
    const setId=progressSetId(url.pathname);
    if(req.method==='GET'&&setId){
      const preferredLanguageCode=String(url.searchParams.get('language')||'en').trim().toLowerCase();
      const preferredVariantCode=String(url.searchParams.get('variant')||'standard').trim().toLowerCase();
      const progress=await getCollectionSetProgressFromStore(store,{userId:user.id,setId:decodeURIComponent(setId),preferredLanguageCode,preferredVariantCode});
      ok(res,{contractVersion:1,progress});return true;
    }
    if(req.method==='POST'&&url.pathname===PREVIEW_PATH){
      const body=await readBody(req);
      if(typeof body.csvText!=='string'||!body.csvText.trim()){fail(res,400,'COLLECTR_CSV_REQUIRED','A user-exported Collectr CSV is required.');return true;}
      const preview=await previewCollectrImportFromStore(store,{userId:user.id,csvText:body.csvText});
      ok(res,Object.freeze({contractVersion:1,mode:'preview_only',source:Object.freeze({name:'collectr',kind:'user_supplied_export',affiliation:'none'}),writesPerformed:false,requiresUserConfirmation:true,confirmationToken:preview.confirmationToken,preview}));
      return true;
    }
    if(req.method==='POST'&&url.pathname===CONFIRM_PATH){
      if(!flags.collectrImportWriteEnabled){fail(res,404,'NOT_FOUND','Collectr import confirmation is not enabled.');return true;}
      const body=await readBody(req);
      if(typeof body.csvText!=='string'||!body.csvText.trim()){fail(res,400,'COLLECTR_CSV_REQUIRED','A user-exported Collectr CSV is required.');return true;}
      if(typeof body.confirmationToken!=='string'||!body.confirmationToken.trim()){fail(res,400,'COLLECTR_CONFIRMATION_TOKEN_REQUIRED','Preview this Collectr CSV before confirming it.');return true;}
      if(body.confirmed!==true){fail(res,400,'IMPORT_CONFIRMATION_REQUIRED','Explicit user confirmation is required before collection ownership is changed.');return true;}
      const result=await confirmCollectrImportFromStore(store,{userId:user.id,csvText:body.csvText,confirmationToken:body.confirmationToken,confirmed:true});
      ok(res,result);return true;
    }
    fail(res,405,'METHOD_NOT_ALLOWED','Method not allowed for this Fate Collectors resource.');return true;
  }catch(error){
    if(error?.message==='REQUEST_TOO_LARGE'){fail(res,413,'COLLECTR_CSV_TOO_LARGE','The Collectr export exceeds the 2 MB import limit.');return true;}
    if(error instanceof SyntaxError){fail(res,400,'INVALID_JSON','Request body must be valid JSON.');return true;}
    if(error?.code==='IMPORT_PREVIEW_CHANGED'||error?.code==='IMPORT_STATE_CHANGED'||error?.code==='IMPORT_PREVIEW_TRUNCATED'){fail(res,409,error.code,error.message);return true;}
    if(error?.code==='IMPORT_CONFIRMATION_REQUIRED'){fail(res,400,error.code,error.message);return true;}
    if(error instanceof TypeError){fail(res,400,'INVALID_COLLECTORS_REQUEST',error.message);return true;}
    throw error;
  }
}
