import {
  makeCollectionEventId,
  makeCollectionId,
  makeCollectionItemId,
  makeExactWantId,
  normalizeCollectionItemInput,
  normalizeCollectionItemPatch,
  normalizeExactWantInput,
  publicCollectionItem,
} from './model.mjs';
import { makeFateTcgId } from '../card-identity.mjs';
import { getVerifiedCardFromStore } from '../catalogue/store.mjs';

function collectionState(state) {
  state.traderCollection ||= {
    collections: {},
    items: {},
    grading: {},
    media: {},
    wants: {},
    events: [],
  };
  return state.traderCollection;
}

function dbItem(row, grading = null) {
  return {
    id: row.id,
    collectionId: row.collection_id,
    fateCardId: row.card_identity_id,
    quantity: Number(row.quantity),
    tradeQuantity: Number(row.trade_quantity),
    copyState: row.copy_state,
    conditionCode: row.condition_code,
    notes: row.notes,
    status: row.status,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    grading: grading ? {
      gradingCompany: grading.grading_company,
      gradeLabel: grading.grade_label,
      gradeValue: grading.grade_value == null ? null : Number(grading.grade_value),
      certificationNumber: grading.certification_number,
      certificationStatus: grading.certification_status,
      verificationSource: grading.verification_source,
      verifiedAt: grading.verified_at == null ? null : Number(grading.verified_at),
    } : null,
  };
}

async function verifiedCardContext(store, fateCardId) {
  const card = await getVerifiedCardFromStore(store, fateCardId);
  if (!card) {
    const error = new Error('Card identity is not verified');
    error.code = 'CARD_IDENTITY_NOT_VERIFIED';
    throw error;
  }
  const tcgId = makeFateTcgId(card.tcgCode);
  return { card, tcgId };
}

function eventPayload(item) {
  if (!item) return null;
  return {
    id: item.id,
    fateCardId: item.fateCardId,
    quantity: item.quantity,
    tradeQuantity: item.tradeQuantity,
    copyState: item.copyState,
    conditionCode: item.conditionCode,
    notes: item.notes,
    status: item.status,
    revision: item.revision,
    grading: item.grading ?? null,
  };
}

function eventTypeForUpdate(before, after) {
  if (before.tradeQuantity !== after.tradeQuantity
      && before.quantity === after.quantity
      && before.notes === after.notes
      && before.conditionCode === after.conditionCode) return 'trade_quantity_changed';
  return 'updated';
}

async function createFile(store, userId, normalized, context) {
  const now = Date.now();
  const collectionId = makeCollectionId(userId, context.tcgId);
  const itemId = makeCollectionItemId();
  return store.mutate((state) => {
    const data = collectionState(state);
    data.collections[collectionId] ||= {
      id: collectionId,
      userId,
      tcgId: context.tcgId,
      name: 'My Collection',
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    };
    const item = {
      id: itemId,
      collectionId,
      fateCardId: normalized.fateCardId,
      quantity: normalized.quantity,
      tradeQuantity: normalized.tradeQuantity,
      copyState: normalized.copyState,
      conditionCode: normalized.conditionCode,
      notes: normalized.notes,
      status: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      grading: normalized.grading,
    };
    data.items[itemId] = item;
    if (normalized.grading) data.grading[itemId] = normalized.grading;
    data.events.push({
      id: makeCollectionEventId(),
      userId,
      collectionItemId: itemId,
      eventType: 'created',
      before: null,
      after: eventPayload(item),
      occurredAt: now,
    });
    data.collections[collectionId].updatedAt = now;
    return publicCollectionItem(item);
  });
}

async function createPostgres(store, userId, normalized, context) {
  const pool = await store.pool();
  const client = await pool.connect();
  const now = Date.now();
  const collectionId = makeCollectionId(userId, context.tcgId);
  const itemId = makeCollectionItemId();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO fatedrop_collections (id,user_id,tcg_id,name,visibility,created_at,updated_at)
      VALUES ($1,$2,$3,'My Collection','private',$4,$4)
      ON CONFLICT (user_id,tcg_id) DO UPDATE SET updated_at=GREATEST(fatedrop_collections.updated_at,EXCLUDED.updated_at)`,
    [collectionId,userId,context.tcgId,now]);
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
    const after = { id:itemId,fateCardId:normalized.fateCardId,quantity:normalized.quantity,tradeQuantity:normalized.tradeQuantity,copyState:normalized.copyState,conditionCode:normalized.conditionCode,notes:normalized.notes,status:'active',revision:1,grading:normalized.grading };
    await client.query(`INSERT INTO fatedrop_collection_item_events
      (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
      VALUES ($1,$2,$3,'created',NULL,$4::jsonb,$5)`,
    [makeCollectionEventId(),userId,itemId,JSON.stringify(after),now]);
    await client.query('COMMIT');
    return publicCollectionItem({ ...after, createdAt: now, updatedAt: now });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createCollectionItemInStore(store, { userId, input }) {
  const normalized = normalizeCollectionItemInput(input);
  const context = await verifiedCardContext(store, normalized.fateCardId);
  if (typeof store?.mutate === 'function') return createFile(store, userId, normalized, context);
  if (typeof store?.pool === 'function') return createPostgres(store, userId, normalized, context);
  throw new Error('Collection persistence is unavailable');
}

async function getFileItem(store, userId, itemId) {
  const state = await store.read();
  const data = collectionState(state);
  const item = data.items[itemId];
  if (!item || item.status !== 'active') return null;
  const collection = data.collections[item.collectionId];
  if (!collection || collection.userId !== userId) return null;
  return item;
}

async function getPostgresItem(store, userId, itemId, client = null) {
  const db = client || await store.pool();
  const { rows } = await db.query(`SELECT i.*,g.grading_company,g.grade_label,g.grade_value,g.certification_number,g.certification_status,g.verification_source,g.verified_at
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    LEFT JOIN fatedrop_collection_grading g ON g.collection_item_id=i.id
    WHERE i.id=$1 AND c.user_id=$2 AND i.status='active'`, [itemId,userId]);
  if (!rows[0]) return null;
  const r = rows[0];
  return dbItem(r, r.grading_company ? r : null);
}

export async function listCollectionItemsFromStore(store, { userId, limit = 500 } = {}) {
  const safe = Math.min(2000, Math.max(1, Number(limit) || 500));
  if (typeof store?.read === 'function') {
    const state = await store.read();
    const data = collectionState(state);
    const ownedCollections = new Set(Object.values(data.collections).filter((c) => c.userId === userId).map((c) => c.id));
    return Object.values(data.items)
      .filter((item) => ownedCollections.has(item.collectionId) && item.status === 'active')
      .sort((a,b) => b.updatedAt - a.updatedAt)
      .slice(0,safe)
      .map(publicCollectionItem);
  }
  if (typeof store?.pool !== 'function') return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT i.*,g.grading_company,g.grade_label,g.grade_value,g.certification_number,g.certification_status,g.verification_source,g.verified_at
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    LEFT JOIN fatedrop_collection_grading g ON g.collection_item_id=i.id
    WHERE c.user_id=$1 AND i.status='active'
    ORDER BY i.updated_at DESC LIMIT $2`, [userId,safe]);
  return rows.map((r) => publicCollectionItem(dbItem(r, r.grading_company ? r : null)));
}

export async function updateCollectionItemInStore(store, { userId, itemId, input, expectedRevision = null }) {
  const current = typeof store?.read === 'function'
    ? await getFileItem(store,userId,itemId)
    : await getPostgresItem(store,userId,itemId);
  if (!current) return null;
  if (expectedRevision != null && current.revision !== expectedRevision) {
    const error = new Error('Collection item revision conflict');
    error.code = 'REVISION_CONFLICT';
    throw error;
  }
  const normalized = normalizeCollectionItemPatch(input,current);
  if (normalized.fateCardId !== current.fateCardId || normalized.copyState !== current.copyState) {
    throw new TypeError('card identity and copyState are immutable; create a new item instead');
  }
  const now = Date.now();
  const next = { ...current, ...normalized, revision: current.revision + 1, updatedAt: now };
  const eventType = eventTypeForUpdate(current,next);

  if (typeof store?.mutate === 'function') {
    return store.mutate((state) => {
      const data = collectionState(state);
      data.items[itemId] = next;
      if (next.grading) data.grading[itemId] = next.grading;
      data.events.push({ id:makeCollectionEventId(),userId,collectionItemId:itemId,eventType,before:eventPayload(current),after:eventPayload(next),occurredAt:now });
      return publicCollectionItem(next);
    });
  }

  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const params = [next.quantity,next.tradeQuantity,next.conditionCode,next.notes,next.revision,now,itemId,userId,current.revision];
    const result = await client.query(`UPDATE fatedrop_collection_items i
      SET quantity=$1,trade_quantity=$2,condition_code=$3,notes=$4,revision=$5,updated_at=$6
      FROM fatedrop_collections c
      WHERE i.id=$7 AND i.collection_id=c.id AND c.user_id=$8 AND i.status='active' AND i.revision=$9
      RETURNING i.id`, params);
    if (!result.rowCount) {
      const error = new Error('Collection item revision conflict'); error.code='REVISION_CONFLICT'; throw error;
    }
    await client.query(`INSERT INTO fatedrop_collection_item_events
      (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [makeCollectionEventId(),userId,itemId,eventType,JSON.stringify(eventPayload(current)),JSON.stringify(eventPayload(next)),now]);
    await client.query('COMMIT');
    return publicCollectionItem(next);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function removeCollectionItemFromStore(store, { userId, itemId, expectedRevision = null }) {
  const current = typeof store?.read === 'function'
    ? await getFileItem(store,userId,itemId)
    : await getPostgresItem(store,userId,itemId);
  if (!current) return false;
  if (expectedRevision != null && current.revision !== expectedRevision) {
    const error = new Error('Collection item revision conflict'); error.code='REVISION_CONFLICT'; throw error;
  }
  const now = Date.now();
  const removed = { ...current, status:'removed', tradeQuantity:0, revision:current.revision+1, updatedAt:now };
  if (typeof store?.mutate === 'function') {
    await store.mutate((state) => {
      const data=collectionState(state); data.items[itemId]=removed;
      data.events.push({id:makeCollectionEventId(),userId,collectionItemId:itemId,eventType:'removed',before:eventPayload(current),after:eventPayload(removed),occurredAt:now});
    });
    return true;
  }
  const pool=await store.pool(); const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const result=await client.query(`UPDATE fatedrop_collection_items i SET status='removed',trade_quantity=0,revision=revision+1,updated_at=$1
      FROM fatedrop_collections c WHERE i.id=$2 AND i.collection_id=c.id AND c.user_id=$3 AND i.status='active' AND i.revision=$4 RETURNING i.id`,
    [now,itemId,userId,current.revision]);
    if(!result.rowCount){const error=new Error('Collection item revision conflict');error.code='REVISION_CONFLICT';throw error;}
    await client.query(`INSERT INTO fatedrop_collection_item_events (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
      VALUES ($1,$2,$3,'removed',$4::jsonb,$5::jsonb,$6)`,
    [makeCollectionEventId(),userId,itemId,JSON.stringify(eventPayload(current)),JSON.stringify(eventPayload(removed)),now]);
    await client.query('COMMIT'); return true;
  } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}

export async function upsertExactWantInStore(store, { userId, fateCardId, input = {} }) {
  const normalized=normalizeExactWantInput(fateCardId,input);
  await verifiedCardContext(store,normalized.fateCardId);
  const now=Date.now(); const id=makeExactWantId(userId,normalized.fateCardId);
  const want={id,userId,cardIdentityId:normalized.fateCardId,quantity:normalized.quantity,active:normalized.active,createdAt:now,updatedAt:now};
  if(typeof store?.mutate==='function'){
    return store.mutate((state)=>{const data=collectionState(state);const existing=data.wants[id];data.wants[id]=existing?{...existing,quantity:want.quantity,active:want.active,updatedAt:now}:want;return data.wants[id];});
  }
  if(typeof store?.pool!=='function')throw new Error('Want persistence is unavailable');
  const pool=await store.pool();
  const {rows}=await pool.query(`INSERT INTO fatedrop_card_wants (id,user_id,card_identity_id,quantity,active,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$6)
    ON CONFLICT (user_id,card_identity_id) DO UPDATE SET quantity=EXCLUDED.quantity,active=EXCLUDED.active,updated_at=EXCLUDED.updated_at
    RETURNING id,user_id,card_identity_id,quantity,active,created_at,updated_at`,[id,userId,normalized.fateCardId,normalized.quantity,normalized.active,now]);
  const r=rows[0];return{id:r.id,userId:r.user_id,fateCardId:r.card_identity_id,quantity:Number(r.quantity),active:r.active,createdAt:Number(r.created_at),updatedAt:Number(r.updated_at)};
}

export async function listExactWantsFromStore(store,{userId,limit=500}={}){
  const safe=Math.min(2000,Math.max(1,Number(limit)||500));
  if(typeof store?.read==='function'){
    const data=collectionState(await store.read());return Object.values(data.wants).filter((w)=>w.userId===userId&&w.active).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,safe).map((w)=>({id:w.id,userId:w.userId,fateCardId:w.cardIdentityId,quantity:w.quantity,active:w.active,createdAt:w.createdAt,updatedAt:w.updatedAt}));
  }
  if(typeof store?.pool!=='function')return[];
  const pool=await store.pool();const{rows}=await pool.query(`SELECT * FROM fatedrop_card_wants WHERE user_id=$1 AND active=true ORDER BY updated_at DESC LIMIT $2`,[userId,safe]);
  return rows.map((r)=>({id:r.id,userId:r.user_id,fateCardId:r.card_identity_id,quantity:Number(r.quantity),active:r.active,createdAt:Number(r.created_at),updatedAt:Number(r.updated_at)}));
}

export async function removeExactWantFromStore(store,{userId,fateCardId}){
  const id=makeExactWantId(userId,fateCardId);const now=Date.now();
  if(typeof store?.mutate==='function')return store.mutate((state)=>{const data=collectionState(state);const want=data.wants[id];if(!want||want.userId!==userId)return false;data.wants[id]={...want,active:false,updatedAt:now};return true;});
  if(typeof store?.pool!=='function')return false;
  const pool=await store.pool();const result=await pool.query(`UPDATE fatedrop_card_wants SET active=false,updated_at=$1 WHERE id=$2 AND user_id=$3 AND active=true`,[now,id,userId]);return result.rowCount>0;
}

export async function addCollectionMediaReference(store,{userId,itemId,mediaRole,storageKey}){
  const current=typeof store?.read==='function'?await getFileItem(store,userId,itemId):await getPostgresItem(store,userId,itemId);
  if(!current)return null;
  const role=String(mediaRole||'').trim();if(!['front','back','certification','detail'].includes(role))throw new TypeError('mediaRole is invalid');
  const key=String(storageKey||'').trim();if(!key)throw new TypeError('storageKey is required');
  const id=`fdmedia_${cryptoRandomKey()}`;const now=Date.now();const media={id,collectionItemId:itemId,mediaRole:role,storageKey:key,mediaStatus:'active',createdAt:now,updatedAt:now};
  if(typeof store?.mutate==='function')return store.mutate((state)=>{collectionState(state).media[id]=media;return media;});
  if(typeof store?.pool!=='function')throw new Error('Collection media persistence is unavailable');
  const pool=await store.pool();await pool.query(`INSERT INTO fatedrop_collection_item_media (id,collection_item_id,media_role,storage_key,media_status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5)`,[id,itemId,role,key,now]);return media;
}

function cryptoRandomKey(){return makeCollectionItemId().replace('fditem_','');}
