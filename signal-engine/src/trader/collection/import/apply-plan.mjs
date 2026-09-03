import {
  createCollectionItemInStore,
  updateCollectionItemInStore,
} from '../store.mjs';
import {
  makeCollectionEventId,
  makeCollectionId,
  makeCollectionItemId,
  normalizeCollectionItemInput,
} from '../model.mjs';
import {
  makeCollectionItemSourceId,
  normalizeCollectionImportSource,
  recordCollectionItemImportSource,
} from '../import-source.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function sourceFor(sourceRecordKey, importBatchKey) {
  return normalizeCollectionImportSource({
    sourceName: 'collectr',
    sourceRecordKey,
    importBatchKey,
    observedAt: null,
  });
}

function eventPayload(item) {
  return {
    id: item.id,
    fateCardId: item.fateCardId,
    quantity: item.quantity,
    tradeQuantity: item.tradeQuantity,
    copyState: item.copyState,
    conditionCode: item.conditionCode ?? null,
    notes: item.notes ?? null,
    status: item.status ?? 'active',
    revision: item.revision,
    grading: item.grading ?? null,
  };
}

async function insertSource(client, { userId, itemId, source, now }) {
  const id = makeCollectionItemSourceId(itemId, source);
  const result = await client.query(`INSERT INTO fatedrop_collection_item_sources
    (id,collection_item_id,source_name,source_record_key,import_batch_key,observed_at,created_at,updated_at)
    SELECT $1,i.id,$2,$3,$4,$5,$6,$6
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    WHERE i.id=$7 AND c.user_id=$8 AND i.status='active'
    ON CONFLICT (id) DO UPDATE SET observed_at=COALESCE(EXCLUDED.observed_at,fatedrop_collection_item_sources.observed_at),updated_at=EXCLUDED.updated_at
    RETURNING id`, [id,source.sourceName,source.sourceRecordKey,source.importBatchKey,source.observedAt,now,itemId,userId]);
  if (!result.rowCount) {
    const error = new Error('Collection import source ownership changed during confirmation');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
}

async function verifiedCardTcgId(client, fateCardId) {
  const { rows } = await client.query(`SELECT tcg_id FROM fatedrop_card_identities
    WHERE id=$1 AND verification_status='verified' LIMIT 1`, [fateCardId]);
  if (!rows[0]?.tcg_id) {
    const error = new Error('Card identity is no longer verified');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  return String(rows[0].tcg_id);
}

async function applyCreate(client, { userId, action, importBatchKey, now }) {
  const normalized = normalizeCollectionItemInput(action.collectionInput);
  if (normalized.fateCardId !== action.match?.fateCardId) {
    const error = new Error('Collectr create identity changed during confirmation');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  const tcgId = await verifiedCardTcgId(client, normalized.fateCardId);
  const collectionId = makeCollectionId(userId, tcgId);
  const itemId = makeCollectionItemId();
  await client.query(`INSERT INTO fatedrop_collections (id,user_id,tcg_id,name,visibility,created_at,updated_at)
    VALUES ($1,$2,$3,'My Collection','private',$4,$4)
    ON CONFLICT (user_id,tcg_id) DO UPDATE SET updated_at=GREATEST(fatedrop_collections.updated_at,EXCLUDED.updated_at)`,
  [collectionId,userId,tcgId,now]);
  await client.query(`INSERT INTO fatedrop_collection_items
    (id,collection_id,card_identity_id,quantity,trade_quantity,copy_state,condition_code,notes,status,revision,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',1,$9,$9)`,
  [itemId,collectionId,normalized.fateCardId,normalized.quantity,normalized.tradeQuantity,normalized.copyState,normalized.conditionCode,normalized.notes,now]);
  if (normalized.grading) {
    const g = normalized.grading;
    await client.query(`INSERT INTO fatedrop_collection_grading
      (collection_item_id,grading_company,grade_label,grade_value,certification_number,certification_status,verification_source,verified_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [itemId,g.gradingCompany,g.gradeLabel,g.gradeValue,g.certificationNumber,g.certificationStatus,g.verificationSource,g.verifiedAt,now]);
  }
  const item = {
    id:itemId,
    fateCardId:normalized.fateCardId,
    quantity:normalized.quantity,
    tradeQuantity:normalized.tradeQuantity,
    copyState:normalized.copyState,
    conditionCode:normalized.conditionCode,
    notes:normalized.notes,
    status:'active',
    revision:1,
    grading:normalized.grading,
  };
  await client.query(`INSERT INTO fatedrop_collection_item_events
    (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
    VALUES ($1,$2,$3,'created',NULL,$4::jsonb,$5)`,
  [makeCollectionEventId(),userId,itemId,JSON.stringify(eventPayload(item)),now]);
  await insertSource(client,{userId,itemId,source:sourceFor(action.sourceRecordKey,importBatchKey),now});
  return itemId;
}

async function currentRawItem(client, { userId, itemId }) {
  const { rows } = await client.query(`SELECT i.id,i.card_identity_id,i.quantity,i.trade_quantity,i.copy_state,i.condition_code,i.notes,i.status,i.revision,i.created_at,i.updated_at
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    WHERE i.id=$1 AND c.user_id=$2 AND i.status='active'
    FOR UPDATE`, [itemId,userId]);
  if (!rows[0]) {
    const error = new Error('Collection item changed during Collectr confirmation');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  return rows[0];
}

async function applyUpdate(client, { userId, action, importBatchKey, now }) {
  const itemId = requireText(action.item?.id, 'update item id');
  const current = await currentRawItem(client,{userId,itemId});
  const expectedRevision = action.expectedRevision == null ? Number(action.item?.revision) : Number(action.expectedRevision);
  if (!Number.isInteger(expectedRevision) || Number(current.revision) !== expectedRevision) {
    const error = new Error('Collection item revision changed after Collectr preview');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  if (current.copy_state !== 'raw' || String(current.card_identity_id) !== String(action.match?.fateCardId)) {
    const error = new Error('Collection item identity changed after Collectr preview');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  const quantity = Number(action.patch?.quantity);
  const conditionCode = String(action.patch?.conditionCode || '').trim();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !conditionCode) {
    const error = new Error('Collectr update patch is invalid');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  if (Number(current.trade_quantity) > quantity) {
    const error = new Error('Imported quantity is below the quantity currently marked for trade');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  const nextRevision = expectedRevision + 1;
  const result = await client.query(`UPDATE fatedrop_collection_items
    SET quantity=$1,condition_code=$2,revision=$3,updated_at=$4
    WHERE id=$5 AND revision=$6 AND status='active' RETURNING id`,
  [quantity,conditionCode,nextRevision,now,itemId,expectedRevision]);
  if (!result.rowCount) {
    const error = new Error('Collection item changed during Collectr confirmation');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  const before = {
    id:itemId,
    fateCardId:String(current.card_identity_id),
    quantity:Number(current.quantity),
    tradeQuantity:Number(current.trade_quantity),
    copyState:current.copy_state,
    conditionCode:current.condition_code,
    notes:current.notes,
    status:'active',
    revision:expectedRevision,
    grading:null,
  };
  const after = {...before,quantity,conditionCode,revision:nextRevision};
  await client.query(`INSERT INTO fatedrop_collection_item_events
    (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
    VALUES ($1,$2,$3,'updated',$4::jsonb,$5::jsonb,$6)`,
  [makeCollectionEventId(),userId,itemId,JSON.stringify(eventPayload(before)),JSON.stringify(eventPayload(after)),now]);
  await insertSource(client,{userId,itemId,source:sourceFor(action.sourceRecordKey ?? action.match?.row?.sourceRecordKey,importBatchKey),now});
  return itemId;
}

async function applyUnchanged(client, { userId, action, importBatchKey, now }) {
  const itemId = requireText(action.item?.id, 'unchanged item id');
  const current = await currentRawItem(client,{userId,itemId});
  if (String(current.card_identity_id) !== String(action.match?.fateCardId)) {
    const error = new Error('Collection item identity changed after Collectr preview');
    error.code = 'IMPORT_STATE_CHANGED';
    throw error;
  }
  const sourceRecordKey = action.source?.sourceRecordKey ?? action.match?.row?.sourceRecordKey ?? action.match?.sourceRecordKey;
  await insertSource(client,{userId,itemId,source:sourceFor(sourceRecordKey,importBatchKey),now});
  return itemId;
}

async function applyPostgres(store, { userId, plan, importBatchKey }) {
  const pool = await store.pool();
  const client = await pool.connect();
  const now = Date.now();
  const created=[]; const updated=[]; const unchanged=[];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`collectr-import:${userId}`]);
    for (const action of plan.creates) created.push(await applyCreate(client,{userId,action,importBatchKey,now}));
    for (const action of plan.updates) updated.push(await applyUpdate(client,{userId,action,importBatchKey,now}));
    for (const action of plan.unchanged) unchanged.push(await applyUnchanged(client,{userId,action,importBatchKey,now}));
    await client.query('COMMIT');
    return Object.freeze({created:Object.freeze(created),updated:Object.freeze(updated),unchanged:Object.freeze(unchanged)});
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function applyFile(store, { userId, plan, importBatchKey }) {
  const created=[]; const updated=[]; const unchanged=[];
  for (const action of plan.creates) {
    const item=await createCollectionItemInStore(store,{userId,input:action.collectionInput});
    const source=await recordCollectionItemImportSource(store,{userId,itemId:item.id,source:sourceFor(action.sourceRecordKey,importBatchKey)});
    if(!source)throw new Error('Collectr import source could not be recorded');
    created.push(item.id);
  }
  for (const action of plan.updates) {
    const item=await updateCollectionItemInStore(store,{userId,itemId:action.item.id,input:action.patch,expectedRevision:action.expectedRevision});
    if(!item)throw new Error('Collectr collection item disappeared during confirmation');
    const source=await recordCollectionItemImportSource(store,{userId,itemId:item.id,source:sourceFor(action.sourceRecordKey ?? action.match?.row?.sourceRecordKey,importBatchKey)});
    if(!source)throw new Error('Collectr import source could not be recorded');
    updated.push(item.id);
  }
  for (const action of plan.unchanged) {
    const itemId=requireText(action.item?.id,'unchanged item id');
    const sourceRecordKey=action.source?.sourceRecordKey ?? action.match?.row?.sourceRecordKey ?? action.match?.sourceRecordKey;
    const source=await recordCollectionItemImportSource(store,{userId,itemId,source:sourceFor(sourceRecordKey,importBatchKey)});
    if(!source)throw new Error('Collectr import source could not be recorded');
    unchanged.push(itemId);
  }
  return Object.freeze({created:Object.freeze(created),updated:Object.freeze(updated),unchanged:Object.freeze(unchanged)});
}

export async function applyCollectionImportPlanInStore(store, { userId, plan, importBatchKey } = {}) {
  const ownerId=requireText(userId,'userId');
  const batchKey=requireText(importBatchKey,'importBatchKey');
  if(!plan||!Array.isArray(plan.creates)||!Array.isArray(plan.updates)||!Array.isArray(plan.unchanged))throw new TypeError('collection import plan is required');
  if(typeof store?.pool==='function')return applyPostgres(store,{userId:ownerId,plan,importBatchKey:batchKey});
  if(typeof store?.mutate==='function'&&typeof store?.read==='function')return applyFile(store,{userId:ownerId,plan,importBatchKey:batchKey});
  throw new Error('Collection import persistence is unavailable');
}
