import { listCollectionImportSourcesFromStore } from '../import-source.mjs';
import { applyCollectionImportPlanInStore } from './apply-plan.mjs';
import {
  collectrTokenMatchesCsv,
  makeCollectrImportBatchKey,
} from './confirmation-token.mjs';
import { previewCollectrImportFromStore } from './preview.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function taggedError(code,message) {
  const error=new Error(message);
  error.code=code;
  return error;
}

function resultSummary(preview,applied,{duplicate=false,writesPerformed=false,batchKey=null}={}) {
  return Object.freeze({
    contractVersion:1,
    mode:'confirmed_import',
    source:Object.freeze({name:'collectr',kind:'user_supplied_export',affiliation:'none'}),
    confirmed:true,
    duplicate,
    writesPerformed,
    importBatchKey:batchKey,
    summary:Object.freeze({
      created:applied?.created?.length ?? 0,
      updated:applied?.updated?.length ?? 0,
      unchanged:applied?.unchanged?.length ?? 0,
      held:preview?.actions?.holds?.length ?? 0,
      staleSourceRecords:preview?.actions?.staleSources?.length ?? 0,
      rejectedCsvRows:preview?.parsed?.rejectedRows ?? 0,
    }),
    held:preview?.actions?.holds ?? Object.freeze([]),
    rejected:preview?.parsed?.rejected ?? Object.freeze([]),
  });
}

export async function confirmCollectrImportFromStore(store, {
  userId,
  csvText,
  confirmationToken,
  confirmed=false,
  existingItemLimit=2000,
}={}) {
  const ownerId=requireText(userId,'userId');
  const token=requireText(confirmationToken,'confirmationToken');
  if(confirmed!==true)throw taggedError('IMPORT_CONFIRMATION_REQUIRED','Explicit user confirmation is required before collection ownership is changed.');
  if(!collectrTokenMatchesCsv(token,csvText))throw taggedError('IMPORT_PREVIEW_CHANGED','The Collectr confirmation does not belong to this CSV export. Preview it again.');

  const preview=await previewCollectrImportFromStore(store,{userId:ownerId,csvText,existingItemLimit});
  const batchKey=makeCollectrImportBatchKey(token);
  if(token!==preview.confirmationToken){
    const sources=await listCollectionImportSourcesFromStore(store,{userId:ownerId,sourceName:'collectr'});
    if(sources.some((source)=>source.importBatchKey===batchKey)){
      return resultSummary(preview,null,{duplicate:true,writesPerformed:false,batchKey});
    }
    throw taggedError('IMPORT_PREVIEW_CHANGED','The collection or catalogue changed after this Collectr preview. Preview the CSV again before confirming.');
  }
  if(preview.scale?.mayBeTruncated===true){
    throw taggedError('IMPORT_PREVIEW_TRUNCATED','The collection is larger than the safe preview window. Increase the bounded import read before confirming.');
  }

  const actionable=preview.actions.creates.length+preview.actions.updates.length+preview.actions.unchanged.length;
  if(actionable===0){
    return resultSummary(preview,{created:[],updated:[],unchanged:[]},{duplicate:false,writesPerformed:false,batchKey});
  }
  const applied=await applyCollectionImportPlanInStore(store,{
    userId:ownerId,
    plan:preview.actions,
    importBatchKey:batchKey,
  });
  return resultSummary(preview,applied,{duplicate:false,writesPerformed:true,batchKey});
}
