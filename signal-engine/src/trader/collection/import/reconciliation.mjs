function text(value) {
  return value == null ? '' : String(value).trim();
}

function sourceKey(sourceName, sourceRecordKey) {
  return `${text(sourceName).toLowerCase()}|${text(sourceRecordKey)}`;
}

function collectionInput(match) {
  const row = match.row || {};
  const gradingCompany = text(row.gradingCompany);
  const gradeLabel = text(row.gradeLabel);
  const quantity = Number(row.quantity ?? 1);
  if (gradingCompany || gradeLabel) {
    if (!gradingCompany || !gradeLabel) return { error:'incomplete_grading_details' };
    if (quantity !== 1) return { error:'graded_quantity_requires_split' };
    return {
      input:{
        fateCardId:match.fateCardId,
        quantity:1,
        tradeQuantity:0,
        copyState:'graded',
        grading:{gradingCompany,gradeLabel},
      },
    };
  }
  return {
    input:{
      fateCardId:match.fateCardId,
      quantity,
      tradeQuantity:0,
      copyState:'raw',
      conditionCode:row.conditionCode || 'unknown',
    },
  };
}

export function planCollectionImportReconciliation({
  sourceName = 'collectr',
  matches,
  existingSources = [],
  existingItems = [],
} = {}) {
  if (!Array.isArray(matches)) throw new TypeError('matches must be an array');
  if (!Array.isArray(existingSources)) throw new TypeError('existingSources must be an array');
  if (!Array.isArray(existingItems)) throw new TypeError('existingItems must be an array');

  const itemsById = new Map(existingItems.map((item)=>[item.id,item]));
  const sourceMap = new Map();
  for (const source of existingSources) {
    if (text(source.sourceName).toLowerCase() !== text(sourceName).toLowerCase()) continue;
    sourceMap.set(sourceKey(source.sourceName,source.sourceRecordKey),source);
  }

  const creates=[];
  const updates=[];
  const unchanged=[];
  const holds=[];
  const seenSourceKeys=new Set();

  for (const match of matches) {
    const recordKey=text(match?.row?.sourceRecordKey ?? match?.sourceRecordKey);
    if (recordKey) seenSourceKeys.add(sourceKey(sourceName,recordKey));
    if (match?.status !== 'exact') {
      holds.push(Object.freeze({match,reason:match?.reason ?? 'import_match_not_exact'}));
      continue;
    }
    if (!recordKey) {
      holds.push(Object.freeze({match,reason:'missing_source_record_key'}));
      continue;
    }
    const built=collectionInput(match);
    if (built.error) {
      holds.push(Object.freeze({match,reason:built.error}));
      continue;
    }

    const existingSource=sourceMap.get(sourceKey(sourceName,recordKey));
    if (!existingSource) {
      creates.push(Object.freeze({match,collectionInput:Object.freeze(built.input),sourceRecordKey:recordKey}));
      continue;
    }
    const item=itemsById.get(existingSource.collectionItemId);
    if (!item || item.status === 'removed') {
      holds.push(Object.freeze({match,reason:'source_points_to_missing_item',existingSource}));
      continue;
    }
    if (item.fateCardId !== match.fateCardId) {
      holds.push(Object.freeze({match,reason:'source_card_identity_conflict',existingSource,item}));
      continue;
    }
    if (item.copyState !== built.input.copyState) {
      holds.push(Object.freeze({match,reason:'copy_state_change_requires_replacement',existingSource,item}));
      continue;
    }
    if (item.copyState === 'graded') {
      unchanged.push(Object.freeze({match,item,source:existingSource}));
      continue;
    }
    const nextQuantity=built.input.quantity;
    const nextCondition=built.input.conditionCode;
    if (Number(item.tradeQuantity ?? 0) > nextQuantity) {
      holds.push(Object.freeze({
        match,
        reason:'import_quantity_below_trade_quantity',
        existingSource,
        item,
        requestedQuantity:nextQuantity,
        tradeQuantity:Number(item.tradeQuantity ?? 0),
      }));
      continue;
    }
    if (Number(item.quantity) === nextQuantity && text(item.conditionCode) === text(nextCondition)) {
      unchanged.push(Object.freeze({match,item,source:existingSource}));
      continue;
    }
    updates.push(Object.freeze({
      match,
      item,
      source:existingSource,
      expectedRevision:item.revision ?? null,
      patch:Object.freeze({quantity:nextQuantity,conditionCode:nextCondition}),
    }));
  }

  const staleSources=[...sourceMap.entries()]
    .filter(([key])=>!seenSourceKeys.has(key))
    .map(([,source])=>Object.freeze({...source}));

  return Object.freeze({
    summary:Object.freeze({
      create:creates.length,
      update:updates.length,
      unchanged:unchanged.length,
      hold:holds.length,
      staleSourceRecords:staleSources.length,
    }),
    creates:Object.freeze(creates),
    updates:Object.freeze(updates),
    unchanged:Object.freeze(unchanged),
    holds:Object.freeze(holds),
    staleSources:Object.freeze(staleSources),
  });
}
