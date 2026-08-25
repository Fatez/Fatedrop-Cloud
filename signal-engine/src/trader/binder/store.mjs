import {
  assertBinderStatusTransition,
  makeBinderEventId,
  makeBinderItemId,
  makeTradeBinderId,
  normalizeBinderItemInput,
  normalizeBinderItemPatch,
  normalizeWantConstraints,
  publicBinderItem,
} from './model.mjs';

function binderState(state) {
  state.traderBinder ||= { binders: {}, items: {}, events: [], wantConstraints: {} };
  return state.traderBinder;
}
function binderPayload(item) {
  if (!item) return null;
  return {
    id:item.id,collectionItemId:item.collectionItemId,fateCardId:item.fateCardId,
    status:item.status,tradeMode:item.tradeMode,visibility:item.visibility,
    localTradeAllowed:item.localTradeAllowed,postalTradeAllowed:item.postalTradeAllowed,
    notes:item.notes,revision:item.revision,
  };
}
function dbBinder(row) {
  if (!row) return null;
  return {
    id:row.id,userId:row.user_id,tcgId:row.tcg_id,name:row.name,visibility:row.visibility,status:row.status,
    localTradeAllowed:row.local_trade_allowed,postalTradeAllowed:row.postal_trade_allowed,
    createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),
  };
}
function dbBinderItem(row) {
  if (!row) return null;
  return {
    id:row.id,binderId:row.binder_id,collectionItemId:row.collection_item_id,
    fateCardId:row.card_identity_id,tradeQuantity:Number(row.trade_quantity),status:row.status,
    tradeMode:row.trade_mode,visibility:row.visibility,localTradeAllowed:row.local_trade_allowed,
    postalTradeAllowed:row.postal_trade_allowed,notes:row.notes,revision:Number(row.revision),
    createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),
  };
}
function dbConstraints(row) {
  if (!row) return null;
  return {
    wantId:row.want_id,copyState:row.copy_state,minimumConditionCode:row.minimum_condition_code,
    minimumGrade:row.minimum_grade == null ? null : Number(row.minimum_grade),
    maximumGrade:row.maximum_grade == null ? null : Number(row.maximum_grade),
    acceptedGradingCompanies:Array.isArray(row.accepted_grading_companies) ? row.accepted_grading_companies : [],
    localTradeAllowed:row.local_trade_allowed,postalTradeAllowed:row.postal_trade_allowed,
    notes:row.notes,revision:Number(row.revision),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),
  };
}

async function ownedTradeableCollectionItem(store,userId,collectionItemId) {
  if (typeof store?.read === 'function') {
    const state=await store.read(); const collection=state.traderCollection;
    const item=collection?.items?.[collectionItemId]; if(!item||item.status!=='active'||item.tradeQuantity<=0)return null;
    const parent=collection?.collections?.[item.collectionId]; if(!parent||parent.userId!==userId)return null;
    return {collectionItemId:item.id,fateCardId:item.fateCardId,tradeQuantity:item.tradeQuantity,tcgId:parent.tcgId};
  }
  if(typeof store?.pool!=='function')return null;
  const pool=await store.pool(); const {rows}=await pool.query(`SELECT i.id AS collection_item_id,i.card_identity_id,i.trade_quantity,c.tcg_id
    FROM fatedrop_collection_items i JOIN fatedrop_collections c ON c.id=i.collection_id
    WHERE i.id=$1 AND c.user_id=$2 AND i.status='active' AND i.trade_quantity>0`,[collectionItemId,userId]);
  const r=rows[0]; return r?{collectionItemId:r.collection_item_id,fateCardId:r.card_identity_id,tradeQuantity:Number(r.trade_quantity),tcgId:r.tcg_id}:null;
}

async function activeWant(store,userId,fateCardId) {
  if(typeof store?.read==='function'){
    const state=await store.read(); const wants=state.traderCollection?.wants||{};
    return Object.values(wants).find((w)=>w.userId===userId&&w.cardIdentityId===fateCardId&&w.active)||null;
  }
  if(typeof store?.pool!=='function')return null;
  const pool=await store.pool(); const {rows}=await pool.query(`SELECT * FROM fatedrop_card_wants WHERE user_id=$1 AND card_identity_id=$2 AND active=true`,[userId,fateCardId]);
  return rows[0]?{id:rows[0].id,userId:rows[0].user_id,cardIdentityId:rows[0].card_identity_id}:null;
}

export async function getTradeBinderFromStore(store,{userId,tcgId=null}={}){
  if(typeof store?.read==='function'){
    const state=await store.read(); const data=binderState(state);
    const binder=Object.values(data.binders).find((b)=>b.userId===userId&&(!tcgId||b.tcgId===tcgId))||null;
    if(!binder)return {binder:null,items:[]};
    const collection=state.traderCollection||{};
    const items=Object.values(data.items).filter((i)=>i.binderId===binder.id).map((i)=>{
      const owned=collection.items?.[i.collectionItemId];
      return publicBinderItem({...i,tradeQuantity:owned?.status==='active'?owned.tradeQuantity:0});
    });
    return {binder,items};
  }
  if(typeof store?.pool!=='function')return {binder:null,items:[]};
  const pool=await store.pool();
  const binderResult=await pool.query(`SELECT * FROM fatedrop_trade_binders WHERE user_id=$1 AND ($2::text IS NULL OR tcg_id=$2) ORDER BY updated_at DESC LIMIT 1`,[userId,tcgId]);
  const binder=dbBinder(binderResult.rows[0]); if(!binder)return {binder:null,items:[]};
  const {rows}=await pool.query(`SELECT bi.*,ci.card_identity_id,CASE WHEN ci.status='active' THEN ci.trade_quantity ELSE 0 END AS trade_quantity
    FROM fatedrop_trade_binder_items bi JOIN fatedrop_collection_items ci ON ci.id=bi.collection_item_id
    WHERE bi.binder_id=$1 ORDER BY bi.updated_at DESC`,[binder.id]);
  return {binder,items:rows.map((r)=>publicBinderItem(dbBinderItem(r)))};
}

export async function updateTradeBinderSettingsInStore(store,{userId,tcgId,input={}}){
  const visibility=String(input.visibility??'private').trim().toLowerCase(); if(!['private','network'].includes(visibility))throw new TypeError('visibility is invalid');
  const status=String(input.status??'active').trim().toLowerCase(); if(!['active','paused'].includes(status))throw new TypeError('status is invalid');
  const localTradeAllowed=input.localTradeAllowed==null?true:Boolean(input.localTradeAllowed);
  const postalTradeAllowed=input.postalTradeAllowed==null?true:Boolean(input.postalTradeAllowed);
  if(!localTradeAllowed&&!postalTradeAllowed)throw new TypeError('at least one trade method must be enabled');
  const now=Date.now(); const id=makeTradeBinderId(userId,tcgId);
  if(typeof store?.mutate==='function')return store.mutate((state)=>{const data=binderState(state);const existing=data.binders[id];
    data.binders[id]={id,userId,tcgId,name:'Trade Binder',visibility,status,localTradeAllowed,postalTradeAllowed,createdAt:existing?.createdAt??now,updatedAt:now};return data.binders[id];});
  if(typeof store?.pool!=='function')throw new Error('Binder persistence is unavailable');
  const pool=await store.pool();const{rows}=await pool.query(`INSERT INTO fatedrop_trade_binders
    (id,user_id,tcg_id,name,visibility,status,local_trade_allowed,postal_trade_allowed,created_at,updated_at)
    VALUES($1,$2,$3,'Trade Binder',$4,$5,$6,$7,$8,$8)
    ON CONFLICT(user_id,tcg_id) DO UPDATE SET visibility=EXCLUDED.visibility,status=EXCLUDED.status,local_trade_allowed=EXCLUDED.local_trade_allowed,postal_trade_allowed=EXCLUDED.postal_trade_allowed,updated_at=EXCLUDED.updated_at RETURNING *`,
    [id,userId,tcgId,visibility,status,localTradeAllowed,postalTradeAllowed,now]);return dbBinder(rows[0]);
}

export async function addTradeBinderItemInStore(store,{userId,input}){
  const normalized=normalizeBinderItemInput(input); const owned=await ownedTradeableCollectionItem(store,userId,normalized.collectionItemId);
  if(!owned){const e=new Error('Collection item is not owned and tradeable');e.code='COLLECTION_ITEM_NOT_TRADEABLE';throw e;}
  const now=Date.now();const binderId=makeTradeBinderId(userId,owned.tcgId);const itemId=makeBinderItemId();
  if(typeof store?.mutate==='function')return store.mutate((state)=>{const data=binderState(state);
    const existing=Object.values(data.items).find((i)=>i.collectionItemId===owned.collectionItemId);if(existing){const e=new Error('Collection item already has a binder entry');e.code='BINDER_ITEM_EXISTS';throw e;}
    data.binders[binderId]||={id:binderId,userId,tcgId:owned.tcgId,name:'Trade Binder',visibility:'private',status:'active',localTradeAllowed:true,postalTradeAllowed:true,createdAt:now,updatedAt:now};
    const binder=data.binders[binderId];if(normalized.visibility==='network'&&binder.visibility!=='network'){const e=new Error('Binder must be network-visible first');e.code='BINDER_NOT_PUBLIC';throw e;}
    const item={id:itemId,binderId,collectionItemId:owned.collectionItemId,fateCardId:owned.fateCardId,tradeQuantity:owned.tradeQuantity,status:'available',...normalized,revision:1,createdAt:now,updatedAt:now};
    data.items[itemId]=item;data.events.push({id:makeBinderEventId(),userId,binderItemId:itemId,eventType:'created',before:null,after:binderPayload(item),occurredAt:now});return publicBinderItem(item);});
  if(typeof store?.pool!=='function')throw new Error('Binder persistence is unavailable');
  const pool=await store.pool();const client=await pool.connect();try{await client.query('BEGIN');
    await client.query(`INSERT INTO fatedrop_trade_binders(id,user_id,tcg_id,name,visibility,status,local_trade_allowed,postal_trade_allowed,created_at,updated_at)
      VALUES($1,$2,$3,'Trade Binder','private','active',true,true,$4,$4) ON CONFLICT(user_id,tcg_id) DO NOTHING`,[binderId,userId,owned.tcgId,now]);
    const binderRes=await client.query(`SELECT * FROM fatedrop_trade_binders WHERE id=$1 AND user_id=$2`,[binderId,userId]);const binder=dbBinder(binderRes.rows[0]);
    if(normalized.visibility==='network'&&binder?.visibility!=='network'){const e=new Error('Binder must be network-visible first');e.code='BINDER_NOT_PUBLIC';throw e;}
    const{rows}=await client.query(`INSERT INTO fatedrop_trade_binder_items(id,binder_id,collection_item_id,status,trade_mode,visibility,local_trade_allowed,postal_trade_allowed,notes,revision,created_at,updated_at)
      VALUES($1,$2,$3,'available',$4,$5,$6,$7,$8,1,$9,$9) RETURNING *`,[itemId,binderId,owned.collectionItemId,normalized.tradeMode,normalized.visibility,normalized.localTradeAllowed,normalized.postalTradeAllowed,normalized.notes,now]);
    const item=dbBinderItem({...rows[0],card_identity_id:owned.fateCardId,trade_quantity:owned.tradeQuantity});
    await client.query(`INSERT INTO fatedrop_trade_binder_events(id,user_id,binder_item_id,event_type,before_json,after_json,occurred_at) VALUES($1,$2,$3,'created',NULL,$4::jsonb,$5)`,[makeBinderEventId(),userId,itemId,JSON.stringify(binderPayload(item)),now]);
    await client.query('COMMIT');return publicBinderItem(item);
  }catch(error){await client.query('ROLLBACK');if(error?.code==='23505'){const e=new Error('Collection item already has a binder entry');e.code='BINDER_ITEM_EXISTS';throw e;}throw error;}finally{client.release();}
}

async function ownedBinderItem(store,userId,itemId){
  if(typeof store?.read==='function'){const state=await store.read();const data=binderState(state);const item=data.items[itemId];const binder=item&&data.binders[item.binderId];return item&&binder?.userId===userId?item:null;}
  if(typeof store?.pool!=='function')return null;const pool=await store.pool();const{rows}=await pool.query(`SELECT bi.*,ci.card_identity_id,CASE WHEN ci.status='active' THEN ci.trade_quantity ELSE 0 END AS trade_quantity
    FROM fatedrop_trade_binder_items bi JOIN fatedrop_trade_binders b ON b.id=bi.binder_id JOIN fatedrop_collection_items ci ON ci.id=bi.collection_item_id WHERE bi.id=$1 AND b.user_id=$2`,[itemId,userId]);return rows[0]?dbBinderItem(rows[0]):null;
}

export async function updateTradeBinderItemInStore(store,{userId,itemId,input={}}){
  const current=await ownedBinderItem(store,userId,itemId);if(!current)return null;
  const patch=normalizeBinderItemPatch(input,current);if(patch.expectedRevision!==current.revision){const e=new Error('Binder item revision conflict');e.code='REVISION_CONFLICT';throw e;}
  const nextStatus=input.status?assertBinderStatusTransition(current.status,input.status):current.status;
  if(nextStatus==='available'){const owned=await ownedTradeableCollectionItem(store,userId,current.collectionItemId);if(!owned){const e=new Error('Collection item is no longer tradeable');e.code='COLLECTION_ITEM_NOT_TRADEABLE';throw e;}}
  const now=Date.now();const next={...current,...patch,status:nextStatus,revision:current.revision+1,updatedAt:now};const eventType=nextStatus!==current.status?(nextStatus==='withdrawn'?'withdrawn':nextStatus==='available'&&current.status==='withdrawn'?'restored':'status_changed'):'updated';
  if(typeof store?.mutate==='function')return store.mutate((state)=>{const data=binderState(state);const binder=data.binders[current.binderId];if(next.visibility==='network'&&binder.visibility!=='network'){const e=new Error('Binder must be network-visible first');e.code='BINDER_NOT_PUBLIC';throw e;}data.items[itemId]=next;data.events.push({id:makeBinderEventId(),userId,binderItemId:itemId,eventType,before:binderPayload(current),after:binderPayload(next),occurredAt:now});return publicBinderItem(next);});
  const pool=await store.pool();const client=await pool.connect();try{await client.query('BEGIN');const binderRes=await client.query(`SELECT visibility FROM fatedrop_trade_binders WHERE id=$1 AND user_id=$2`,[current.binderId,userId]);if(next.visibility==='network'&&binderRes.rows[0]?.visibility!=='network'){const e=new Error('Binder must be network-visible first');e.code='BINDER_NOT_PUBLIC';throw e;}
    const result=await client.query(`UPDATE fatedrop_trade_binder_items bi SET status=$1,trade_mode=$2,visibility=$3,local_trade_allowed=$4,postal_trade_allowed=$5,notes=$6,revision=$7,updated_at=$8
      FROM fatedrop_trade_binders b WHERE bi.id=$9 AND bi.binder_id=b.id AND b.user_id=$10 AND bi.revision=$11 RETURNING bi.*`,[next.status,next.tradeMode,next.visibility,next.localTradeAllowed,next.postalTradeAllowed,next.notes,next.revision,now,itemId,userId,current.revision]);
    if(!result.rowCount){const e=new Error('Binder item revision conflict');e.code='REVISION_CONFLICT';throw e;}await client.query(`INSERT INTO fatedrop_trade_binder_events(id,user_id,binder_item_id,event_type,before_json,after_json,occurred_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,[makeBinderEventId(),userId,itemId,eventType,JSON.stringify(binderPayload(current)),JSON.stringify(binderPayload(next)),now]);await client.query('COMMIT');return publicBinderItem(next);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function upsertWantConstraintsInStore(store,{userId,fateCardId,input={}}){
  const want=await activeWant(store,userId,fateCardId);if(!want){const e=new Error('Active exact Want is required');e.code='WANT_NOT_FOUND';throw e;}
  let current=null;if(typeof store?.read==='function'){const state=await store.read();current=binderState(state).wantConstraints[want.id]||null;}else if(typeof store?.pool==='function'){const pool=await store.pool();const{rows}=await pool.query(`SELECT * FROM fatedrop_want_constraints WHERE want_id=$1`,[want.id]);current=dbConstraints(rows[0]);}
  const normalized=normalizeWantConstraints(input,current);if(current&&normalized.expectedRevision!==current.revision){const e=new Error('Want constraint revision conflict');e.code='REVISION_CONFLICT';throw e;}
  const now=Date.now();const next={wantId:want.id,...normalized,revision:current?current.revision+1:1,createdAt:current?.createdAt??now,updatedAt:now};
  if(typeof store?.mutate==='function')return store.mutate((state)=>{binderState(state).wantConstraints[want.id]=next;return next;});
  if(typeof store?.pool!=='function')throw new Error('Want constraint persistence is unavailable');const pool=await store.pool();const{rows}=await pool.query(`INSERT INTO fatedrop_want_constraints
    (want_id,copy_state,minimum_condition_code,minimum_grade,maximum_grade,accepted_grading_companies,local_trade_allowed,postal_trade_allowed,notes,revision,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,1,$10,$10)
    ON CONFLICT(want_id) DO UPDATE SET copy_state=EXCLUDED.copy_state,minimum_condition_code=EXCLUDED.minimum_condition_code,minimum_grade=EXCLUDED.minimum_grade,maximum_grade=EXCLUDED.maximum_grade,accepted_grading_companies=EXCLUDED.accepted_grading_companies,local_trade_allowed=EXCLUDED.local_trade_allowed,postal_trade_allowed=EXCLUDED.postal_trade_allowed,notes=EXCLUDED.notes,revision=fatedrop_want_constraints.revision+1,updated_at=EXCLUDED.updated_at RETURNING *`,
    [want.id,next.copyState,next.minimumConditionCode,next.minimumGrade,next.maximumGrade,JSON.stringify(next.acceptedGradingCompanies),next.localTradeAllowed,next.postalTradeAllowed,next.notes,now]);return dbConstraints(rows[0]);
}

export async function getWantConstraintsFromStore(store,{userId,fateCardId}){
  const want=await activeWant(store,userId,fateCardId);if(!want)return null;
  if(typeof store?.read==='function'){const state=await store.read();return binderState(state).wantConstraints[want.id]||null;}
  if(typeof store?.pool!=='function')return null;const pool=await store.pool();const{rows}=await pool.query(`SELECT wc.* FROM fatedrop_want_constraints wc JOIN fatedrop_card_wants w ON w.id=wc.want_id WHERE wc.want_id=$1 AND w.user_id=$2 AND w.active=true`,[want.id,userId]);return dbConstraints(rows[0]);
}
