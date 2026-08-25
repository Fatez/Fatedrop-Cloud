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

function stateFor(root) {
  root.traderBinder ||= { binders: {}, items: {}, events: [], wantConstraints: {} };
  return root.traderBinder;
}

function binderPublic(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    userId: row.userId,
    tcgId: row.tcgId,
    name: row.name,
    visibility: row.visibility,
    status: row.status,
    localTradeAllowed: row.localTradeAllowed,
    postalTradeAllowed: row.postalTradeAllowed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function binderFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tcgId: row.tcg_id,
    name: row.name,
    visibility: row.visibility,
    status: row.status,
    localTradeAllowed: row.local_trade_allowed,
    postalTradeAllowed: row.postal_trade_allowed,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function binderItemFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    binderId: row.binder_id,
    collectionItemId: row.collection_item_id,
    fateCardId: row.card_identity_id,
    tradeQuantity: Number(row.trade_quantity ?? 0),
    status: row.status,
    tradeMode: row.trade_mode,
    visibility: row.visibility,
    localTradeAllowed: row.local_trade_allowed,
    postalTradeAllowed: row.postal_trade_allowed,
    notes: row.notes,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function constraintFromDb(row) {
  if (!row) return null;
  return Object.freeze({
    wantId: row.want_id,
    copyState: row.copy_state,
    minimumConditionCode: row.minimum_condition_code,
    minimumGrade: row.minimum_grade == null ? null : Number(row.minimum_grade),
    maximumGrade: row.maximum_grade == null ? null : Number(row.maximum_grade),
    acceptedGradingCompanies: Array.isArray(row.accepted_grading_companies) ? row.accepted_grading_companies : [],
    localTradeAllowed: row.local_trade_allowed,
    postalTradeAllowed: row.postal_trade_allowed,
    notes: row.notes,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

function itemEventPayload(item) {
  if (!item) return null;
  return {
    id: item.id,
    collectionItemId: item.collectionItemId,
    fateCardId: item.fateCardId,
    status: item.status,
    tradeMode: item.tradeMode,
    visibility: item.visibility,
    localTradeAllowed: item.localTradeAllowed,
    postalTradeAllowed: item.postalTradeAllowed,
    notes: item.notes ?? null,
    revision: item.revision,
  };
}

function publicEffectiveItem(item, ownedTradeQuantity) {
  const tradeQuantity = Math.max(0, Number(ownedTradeQuantity) || 0);
  const effectiveAvailable = item.status === 'available' && tradeQuantity > 0;
  return Object.freeze({
    ...publicBinderItem({ ...item, tradeQuantity }),
    effectiveAvailable,
    staleReason: item.status === 'available' && tradeQuantity <= 0 ? 'collection_not_tradeable' : null,
  });
}

function normalizeBinderSettings(input = {}, current = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('binder settings are required');
  const visibility = String(input.visibility ?? current?.visibility ?? 'private').trim().toLowerCase();
  const status = String(input.status ?? current?.status ?? 'active').trim().toLowerCase();
  if (!['private', 'network'].includes(visibility)) throw new TypeError('visibility is invalid');
  if (!['active', 'paused'].includes(status)) throw new TypeError('status is invalid');
  const localTradeAllowed = input.localTradeAllowed == null ? (current?.localTradeAllowed ?? true) : Boolean(input.localTradeAllowed);
  const postalTradeAllowed = input.postalTradeAllowed == null ? (current?.postalTradeAllowed ?? true) : Boolean(input.postalTradeAllowed);
  if (!localTradeAllowed && !postalTradeAllowed) throw new TypeError('at least one trade method must be enabled');
  return { visibility, status, localTradeAllowed, postalTradeAllowed };
}

async function ownedCollectionContext(store, userId, collectionItemId) {
  if (typeof store?.read === 'function') {
    const root = await store.read();
    const collectionState = root.traderCollection;
    const item = collectionState?.items?.[collectionItemId];
    if (!item || item.status !== 'active') return null;
    const collection = collectionState?.collections?.[item.collectionId];
    if (!collection || collection.userId !== userId) return null;
    return {
      collectionItemId: item.id,
      fateCardId: item.fateCardId,
      tradeQuantity: Number(item.tradeQuantity) || 0,
      tcgId: collection.tcgId,
    };
  }
  if (typeof store?.pool !== 'function') return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT i.id AS collection_item_id,i.card_identity_id,i.trade_quantity,c.tcg_id
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    WHERE i.id=$1 AND c.user_id=$2 AND i.status='active'`, [collectionItemId, userId]);
  const row = rows[0];
  return row ? {
    collectionItemId: row.collection_item_id,
    fateCardId: row.card_identity_id,
    tradeQuantity: Number(row.trade_quantity),
    tcgId: row.tcg_id,
  } : null;
}

async function requireTradeableCollectionContext(store, userId, collectionItemId) {
  const context = await ownedCollectionContext(store, userId, collectionItemId);
  if (!context || context.tradeQuantity <= 0) {
    const error = new Error('Collection item is not owned and tradeable');
    error.code = 'COLLECTION_ITEM_NOT_TRADEABLE';
    throw error;
  }
  return context;
}

async function activeWant(store, userId, fateCardId, client = null) {
  if (typeof store?.read === 'function') {
    const root = await store.read();
    return Object.values(root.traderCollection?.wants || {}).find(
      (want) => want.userId === userId && want.cardIdentityId === fateCardId && want.active,
    ) || null;
  }
  if (typeof store?.pool !== 'function') return null;
  const db = client || await store.pool();
  const { rows } = await db.query(`SELECT id,user_id,card_identity_id,quantity,active,created_at,updated_at
    FROM fatedrop_card_wants WHERE user_id=$1 AND card_identity_id=$2 AND active=true`, [userId, fateCardId]);
  return rows[0] || null;
}

export async function getTradeBinder(store, { userId, tcgId }) {
  if (typeof store?.read === 'function') {
    const root = await store.read();
    const data = stateFor(root);
    const binder = Object.values(data.binders).find((row) => row.userId === userId && row.tcgId === tcgId) || null;
    if (!binder) return Object.freeze({ binder: null, items: [] });
    const collectionItems = root.traderCollection?.items || {};
    const items = Object.values(data.items)
      .filter((item) => item.binderId === binder.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => {
        const owned = collectionItems[item.collectionItemId];
        return publicEffectiveItem(item, owned?.status === 'active' ? owned.tradeQuantity : 0);
      });
    return Object.freeze({ binder: binderPublic(binder), items: Object.freeze(items) });
  }

  if (typeof store?.pool !== 'function') return Object.freeze({ binder: null, items: [] });
  const pool = await store.pool();
  const binderResult = await pool.query(`SELECT * FROM fatedrop_trade_binders WHERE user_id=$1 AND tcg_id=$2`, [userId, tcgId]);
  const binder = binderFromDb(binderResult.rows[0]);
  if (!binder) return Object.freeze({ binder: null, items: [] });
  const { rows } = await pool.query(`SELECT bi.*,ci.card_identity_id,
      CASE WHEN ci.status='active' THEN ci.trade_quantity ELSE 0 END AS trade_quantity
    FROM fatedrop_trade_binder_items bi
    JOIN fatedrop_collection_items ci ON ci.id=bi.collection_item_id
    WHERE bi.binder_id=$1 ORDER BY bi.updated_at DESC`, [binder.id]);
  const items = rows.map((row) => {
    const item = binderItemFromDb(row);
    return publicEffectiveItem(item, item.tradeQuantity);
  });
  return Object.freeze({ binder: binderPublic(binder), items: Object.freeze(items) });
}

export async function patchTradeBinderSettings(store, { userId, tcgId, input = {} }) {
  const now = Date.now();
  const binderId = makeTradeBinderId(userId, tcgId);

  if (typeof store?.mutate === 'function') {
    return store.mutate((root) => {
      const data = stateFor(root);
      const current = data.binders[binderId] || null;
      const settings = normalizeBinderSettings(input, current);
      const next = {
        id: binderId,
        userId,
        tcgId,
        name: current?.name ?? 'Trade Binder',
        ...settings,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      data.binders[binderId] = next;
      return binderPublic(next);
    });
  }

  if (typeof store?.pool !== 'function') throw new Error('Binder persistence is unavailable');
  const pool = await store.pool();
  const existingResult = await pool.query(`SELECT * FROM fatedrop_trade_binders WHERE user_id=$1 AND tcg_id=$2`, [userId, tcgId]);
  const current = binderFromDb(existingResult.rows[0]);
  const settings = normalizeBinderSettings(input, current);
  const { rows } = await pool.query(`INSERT INTO fatedrop_trade_binders
    (id,user_id,tcg_id,name,visibility,status,local_trade_allowed,postal_trade_allowed,created_at,updated_at)
    VALUES($1,$2,$3,'Trade Binder',$4,$5,$6,$7,$8,$8)
    ON CONFLICT(user_id,tcg_id) DO UPDATE SET
      visibility=EXCLUDED.visibility,status=EXCLUDED.status,
      local_trade_allowed=EXCLUDED.local_trade_allowed,postal_trade_allowed=EXCLUDED.postal_trade_allowed,
      updated_at=EXCLUDED.updated_at
    RETURNING *`, [binderId, userId, tcgId, settings.visibility, settings.status, settings.localTradeAllowed, settings.postalTradeAllowed, now]);
  return binderPublic(binderFromDb(rows[0]));
}

export async function addTradeBinderItem(store, { userId, input }) {
  const normalized = normalizeBinderItemInput(input);
  const owned = await requireTradeableCollectionContext(store, userId, normalized.collectionItemId);
  const now = Date.now();
  const binderId = makeTradeBinderId(userId, owned.tcgId);
  const itemId = makeBinderItemId();

  if (typeof store?.mutate === 'function') {
    return store.mutate((root) => {
      const data = stateFor(root);
      const duplicate = Object.values(data.items).find((item) => item.collectionItemId === owned.collectionItemId);
      if (duplicate) {
        const error = new Error('Collection item already has a binder entry');
        error.code = 'BINDER_ITEM_EXISTS';
        throw error;
      }
      data.binders[binderId] ||= {
        id: binderId, userId, tcgId: owned.tcgId, name: 'Trade Binder', visibility: 'private', status: 'active',
        localTradeAllowed: true, postalTradeAllowed: true, createdAt: now, updatedAt: now,
      };
      const binder = data.binders[binderId];
      if (normalized.visibility === 'network' && binder.visibility !== 'network') {
        const error = new Error('Binder must be network-visible first');
        error.code = 'BINDER_NOT_PUBLIC';
        throw error;
      }
      const item = {
        id: itemId,
        binderId,
        collectionItemId: owned.collectionItemId,
        fateCardId: owned.fateCardId,
        status: 'available',
        tradeMode: normalized.tradeMode,
        visibility: normalized.visibility,
        localTradeAllowed: normalized.localTradeAllowed,
        postalTradeAllowed: normalized.postalTradeAllowed,
        notes: normalized.notes,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      data.items[itemId] = item;
      data.events.push({
        id: makeBinderEventId(), userId, binderItemId: itemId, eventType: 'created',
        before: null, after: itemEventPayload(item), occurredAt: now,
      });
      return publicEffectiveItem(item, owned.tradeQuantity);
    });
  }

  if (typeof store?.pool !== 'function') throw new Error('Binder persistence is unavailable');
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO fatedrop_trade_binders
      (id,user_id,tcg_id,name,visibility,status,local_trade_allowed,postal_trade_allowed,created_at,updated_at)
      VALUES($1,$2,$3,'Trade Binder','private','active',true,true,$4,$4)
      ON CONFLICT(user_id,tcg_id) DO NOTHING`, [binderId, userId, owned.tcgId, now]);
    const binderResult = await client.query(`SELECT * FROM fatedrop_trade_binders WHERE id=$1 AND user_id=$2 FOR UPDATE`, [binderId, userId]);
    const binder = binderFromDb(binderResult.rows[0]);
    if (!binder) throw new Error('Binder ownership invariant failed');
    if (normalized.visibility === 'network' && binder.visibility !== 'network') {
      const error = new Error('Binder must be network-visible first');
      error.code = 'BINDER_NOT_PUBLIC';
      throw error;
    }
    const duplicate = await client.query(`SELECT id FROM fatedrop_trade_binder_items WHERE collection_item_id=$1`, [owned.collectionItemId]);
    if (duplicate.rowCount) {
      const error = new Error('Collection item already has a binder entry');
      error.code = 'BINDER_ITEM_EXISTS';
      throw error;
    }
    const { rows } = await client.query(`INSERT INTO fatedrop_trade_binder_items
      (id,binder_id,collection_item_id,status,trade_mode,visibility,local_trade_allowed,postal_trade_allowed,notes,revision,created_at,updated_at)
      VALUES($1,$2,$3,'available',$4,$5,$6,$7,$8,1,$9,$9) RETURNING *`,
    [itemId, binderId, owned.collectionItemId, normalized.tradeMode, normalized.visibility, normalized.localTradeAllowed, normalized.postalTradeAllowed, normalized.notes, now]);
    const item = binderItemFromDb({ ...rows[0], card_identity_id: owned.fateCardId, trade_quantity: owned.tradeQuantity });
    await client.query(`INSERT INTO fatedrop_trade_binder_events
      (id,user_id,binder_item_id,event_type,before_json,after_json,occurred_at)
      VALUES($1,$2,$3,'created',NULL,$4::jsonb,$5)`, [makeBinderEventId(), userId, itemId, JSON.stringify(itemEventPayload(item)), now]);
    await client.query('COMMIT');
    return publicEffectiveItem(item, owned.tradeQuantity);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      const duplicate = new Error('Collection item already has a binder entry');
      duplicate.code = 'BINDER_ITEM_EXISTS';
      throw duplicate;
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ownedBinderItem(store, userId, itemId) {
  if (typeof store?.read === 'function') {
    const root = await store.read();
    const data = stateFor(root);
    const item = data.items[itemId];
    const binder = item ? data.binders[item.binderId] : null;
    if (!item || binder?.userId !== userId) return null;
    const owned = root.traderCollection?.items?.[item.collectionItemId];
    return { item, tradeQuantity: owned?.status === 'active' ? Number(owned.tradeQuantity) || 0 : 0 };
  }
  if (typeof store?.pool !== 'function') return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT bi.*,ci.card_identity_id,
      CASE WHEN ci.status='active' THEN ci.trade_quantity ELSE 0 END AS trade_quantity
    FROM fatedrop_trade_binder_items bi
    JOIN fatedrop_trade_binders b ON b.id=bi.binder_id
    JOIN fatedrop_collection_items ci ON ci.id=bi.collection_item_id
    WHERE bi.id=$1 AND b.user_id=$2`, [itemId, userId]);
  const item = binderItemFromDb(rows[0]);
  return item ? { item, tradeQuantity: item.tradeQuantity } : null;
}

export async function patchTradeBinderItem(store, { userId, itemId, input = {} }) {
  const found = await ownedBinderItem(store, userId, itemId);
  if (!found) return null;
  const current = found.item;
  const patch = normalizeBinderItemPatch(input, current);
  if (patch.expectedRevision !== current.revision) {
    const error = new Error('Binder item revision conflict');
    error.code = 'REVISION_CONFLICT';
    throw error;
  }
  const nextStatus = input.status ? assertBinderStatusTransition(current.status, input.status) : current.status;
  if (nextStatus === 'available') await requireTradeableCollectionContext(store, userId, current.collectionItemId);
  const now = Date.now();
  const next = {
    ...current,
    tradeMode: patch.tradeMode,
    visibility: patch.visibility,
    localTradeAllowed: patch.localTradeAllowed,
    postalTradeAllowed: patch.postalTradeAllowed,
    notes: patch.notes,
    status: nextStatus,
    revision: current.revision + 1,
    updatedAt: now,
  };
  const eventType = nextStatus !== current.status
    ? (nextStatus === 'withdrawn' ? 'withdrawn' : current.status === 'withdrawn' && nextStatus === 'available' ? 'restored' : 'status_changed')
    : 'updated';

  if (typeof store?.mutate === 'function') {
    return store.mutate((root) => {
      const data = stateFor(root);
      const binder = data.binders[current.binderId];
      if (!binder || binder.userId !== userId) return null;
      if (next.visibility === 'network' && binder.visibility !== 'network') {
        const error = new Error('Binder must be network-visible first');
        error.code = 'BINDER_NOT_PUBLIC';
        throw error;
      }
      const live = data.items[itemId];
      if (!live || live.revision !== current.revision) {
        const error = new Error('Binder item revision conflict');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      data.items[itemId] = next;
      data.events.push({
        id: makeBinderEventId(), userId, binderItemId: itemId, eventType,
        before: itemEventPayload(current), after: itemEventPayload(next), occurredAt: now,
      });
      return publicEffectiveItem(next, found.tradeQuantity);
    });
  }

  if (typeof store?.pool !== 'function') throw new Error('Binder persistence is unavailable');
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const binderResult = await client.query(`SELECT visibility FROM fatedrop_trade_binders WHERE id=$1 AND user_id=$2 FOR UPDATE`, [current.binderId, userId]);
    if (!binderResult.rowCount) return null;
    if (next.visibility === 'network' && binderResult.rows[0].visibility !== 'network') {
      const error = new Error('Binder must be network-visible first');
      error.code = 'BINDER_NOT_PUBLIC';
      throw error;
    }
    if (next.status === 'available') {
      const tradeable = await client.query(`SELECT i.trade_quantity FROM fatedrop_collection_items i
        JOIN fatedrop_collections c ON c.id=i.collection_id
        WHERE i.id=$1 AND c.user_id=$2 AND i.status='active' AND i.trade_quantity>0`, [current.collectionItemId, userId]);
      if (!tradeable.rowCount) {
        const error = new Error('Collection item is no longer tradeable');
        error.code = 'COLLECTION_ITEM_NOT_TRADEABLE';
        throw error;
      }
    }
    const result = await client.query(`UPDATE fatedrop_trade_binder_items bi SET
        status=$1,trade_mode=$2,visibility=$3,local_trade_allowed=$4,postal_trade_allowed=$5,
        notes=$6,revision=$7,updated_at=$8
      FROM fatedrop_trade_binders b
      WHERE bi.id=$9 AND bi.binder_id=b.id AND b.user_id=$10 AND bi.revision=$11 RETURNING bi.*`,
    [next.status, next.tradeMode, next.visibility, next.localTradeAllowed, next.postalTradeAllowed, next.notes, next.revision, now, itemId, userId, current.revision]);
    if (!result.rowCount) {
      const error = new Error('Binder item revision conflict');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    await client.query(`INSERT INTO fatedrop_trade_binder_events
      (id,user_id,binder_item_id,event_type,before_json,after_json,occurred_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [makeBinderEventId(), userId, itemId, eventType, JSON.stringify(itemEventPayload(current)), JSON.stringify(itemEventPayload(next)), now]);
    await client.query('COMMIT');
    return publicEffectiveItem(next, found.tradeQuantity);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getWantConstraints(store, { userId, fateCardId }) {
  const want = await activeWant(store, userId, fateCardId);
  if (!want) return null;
  const wantId = want.id;
  if (typeof store?.read === 'function') {
    const root = await store.read();
    return stateFor(root).wantConstraints[wantId] || null;
  }
  if (typeof store?.pool !== 'function') return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT wc.* FROM fatedrop_want_constraints wc
    JOIN fatedrop_card_wants w ON w.id=wc.want_id
    WHERE wc.want_id=$1 AND w.user_id=$2 AND w.active=true`, [wantId, userId]);
  return constraintFromDb(rows[0]);
}

export async function putWantConstraints(store, { userId, fateCardId, input = {} }) {
  if (typeof store?.mutate === 'function') {
    const want = await activeWant(store, userId, fateCardId);
    if (!want) {
      const error = new Error('Active exact Want is required');
      error.code = 'WANT_NOT_FOUND';
      throw error;
    }
    return store.mutate((root) => {
      const data = stateFor(root);
      const current = data.wantConstraints[want.id] || null;
      const normalized = normalizeWantConstraints(input, current);
      if (current && normalized.expectedRevision !== current.revision) {
        const error = new Error('Want constraint revision conflict');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      const now = Date.now();
      const next = Object.freeze({
        wantId: want.id,
        copyState: normalized.copyState,
        minimumConditionCode: normalized.minimumConditionCode,
        minimumGrade: normalized.minimumGrade,
        maximumGrade: normalized.maximumGrade,
        acceptedGradingCompanies: normalized.acceptedGradingCompanies,
        localTradeAllowed: normalized.localTradeAllowed,
        postalTradeAllowed: normalized.postalTradeAllowed,
        notes: normalized.notes,
        revision: current ? current.revision + 1 : 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      data.wantConstraints[want.id] = next;
      return next;
    });
  }

  if (typeof store?.pool !== 'function') throw new Error('Want constraint persistence is unavailable');
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const want = await activeWant(store, userId, fateCardId, client);
    if (!want) {
      const error = new Error('Active exact Want is required');
      error.code = 'WANT_NOT_FOUND';
      throw error;
    }
    const currentResult = await client.query(`SELECT * FROM fatedrop_want_constraints WHERE want_id=$1 FOR UPDATE`, [want.id]);
    const current = constraintFromDb(currentResult.rows[0]);
    const normalized = normalizeWantConstraints(input, current);
    if (current && normalized.expectedRevision !== current.revision) {
      const error = new Error('Want constraint revision conflict');
      error.code = 'REVISION_CONFLICT';
      throw error;
    }
    const now = Date.now();
    let rows;
    if (!current) {
      const inserted = await client.query(`INSERT INTO fatedrop_want_constraints
        (want_id,copy_state,minimum_condition_code,minimum_grade,maximum_grade,accepted_grading_companies,
         local_trade_allowed,postal_trade_allowed,notes,revision,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,1,$10,$10) RETURNING *`,
      [want.id, normalized.copyState, normalized.minimumConditionCode, normalized.minimumGrade, normalized.maximumGrade,
        JSON.stringify(normalized.acceptedGradingCompanies), normalized.localTradeAllowed, normalized.postalTradeAllowed, normalized.notes, now]);
      rows = inserted.rows;
    } else {
      const updated = await client.query(`UPDATE fatedrop_want_constraints SET
          copy_state=$1,minimum_condition_code=$2,minimum_grade=$3,maximum_grade=$4,accepted_grading_companies=$5::jsonb,
          local_trade_allowed=$6,postal_trade_allowed=$7,notes=$8,revision=revision+1,updated_at=$9
        WHERE want_id=$10 AND revision=$11 RETURNING *`,
      [normalized.copyState, normalized.minimumConditionCode, normalized.minimumGrade, normalized.maximumGrade,
        JSON.stringify(normalized.acceptedGradingCompanies), normalized.localTradeAllowed, normalized.postalTradeAllowed,
        normalized.notes, now, want.id, current.revision]);
      if (!updated.rowCount) {
        const error = new Error('Want constraint revision conflict');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      rows = updated.rows;
    }
    await client.query('COMMIT');
    return constraintFromDb(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
