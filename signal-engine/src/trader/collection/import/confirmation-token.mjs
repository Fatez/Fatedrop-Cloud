import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function sourceRecordKey(action) {
  return text(action?.sourceRecordKey ?? action?.source?.sourceRecordKey ?? action?.match?.row?.sourceRecordKey ?? action?.match?.sourceRecordKey);
}

function actionState(preview) {
  const plan=preview?.actions;
  if(!plan)throw new TypeError('Collectr preview actions are required');
  return {
    scale:{mayBeTruncated:preview?.scale?.mayBeTruncated===true,existingItemsRead:Number(preview?.scale?.existingItemsRead||0),existingItemLimit:Number(preview?.scale?.existingItemLimit||0)},
    creates:plan.creates.map((action)=>({
      sourceRecordKey:sourceRecordKey(action),
      fateCardId:text(action?.match?.fateCardId),
      collectionInput:action?.collectionInput ?? null,
    })),
    updates:plan.updates.map((action)=>({
      sourceRecordKey:sourceRecordKey(action),
      fateCardId:text(action?.match?.fateCardId),
      itemId:text(action?.item?.id),
      expectedRevision:action?.expectedRevision ?? null,
      patch:action?.patch ?? null,
    })),
    unchanged:plan.unchanged.map((action)=>({
      sourceRecordKey:sourceRecordKey(action),
      fateCardId:text(action?.match?.fateCardId),
      itemId:text(action?.item?.id),
      revision:action?.item?.revision ?? null,
    })),
    holds:plan.holds.map((action)=>({
      sourceRecordKey:sourceRecordKey(action),
      status:text(action?.match?.status),
      reason:text(action?.reason),
      fateCardId:text(action?.match?.fateCardId),
      candidates:(action?.match?.candidates||[]).map((candidate)=>text(candidate?.fateCardId)).filter(Boolean).sort(),
    })),
    staleSources:plan.staleSources.map((source)=>({
      sourceRecordKey:text(source?.sourceRecordKey),
      collectionItemId:text(source?.collectionItemId),
    })),
  };
}

export function collectrCsvDigest(csvText) {
  if(typeof csvText!=='string'||!csvText.trim())throw new TypeError('csvText is required');
  return sha256(csvText);
}

export function makeCollectrConfirmationToken({csvText,preview}) {
  const csvDigest=collectrCsvDigest(csvText);
  const stateDigest=sha256(JSON.stringify(actionState(preview)));
  return `fdcollectrconfirm_v1_${csvDigest.slice(0,24)}_${stateDigest.slice(0,40)}`;
}

export function collectrTokenMatchesCsv(token,csvText) {
  const match=String(token||'').trim().match(/^fdcollectrconfirm_v1_([a-f0-9]{24})_([a-f0-9]{40})$/);
  if(!match)return false;
  return collectrCsvDigest(csvText).startsWith(match[1]);
}

export function makeCollectrImportBatchKey(token) {
  const clean=String(token||'').trim();
  if(!/^fdcollectrconfirm_v1_[a-f0-9]{24}_[a-f0-9]{40}$/.test(clean))throw new TypeError('confirmationToken is invalid');
  return `collectr:${sha256(clean).slice(0,32)}`;
}
