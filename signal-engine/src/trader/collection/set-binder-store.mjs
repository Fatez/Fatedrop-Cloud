import { createHash } from 'node:crypto';

import { getVerifiedCardSetFromStore } from '../catalogue/store.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function binderId(userId, setId) {
  const digest = createHash('sha256').update(`${userId}|${setId}`).digest('hex').slice(0, 24);
  return `fdcollectionbinder_${digest}`;
}

function fileCollection(state) {
  state.traderCollection ||= {
    collections: {},
    items: {},
    grading: {},
    media: {},
    wants: {},
    events: [],
  };
  state.traderCollection.setBinders ||= {};
  return state.traderCollection;
}

function publicBinder(row) {
  return Object.freeze({
    id: row.id,
    setId: row.setId,
    tracked: row.status === 'tracked',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export async function listTrackedCollectionSetBindersFromStore(store, { userId } = {}) {
  const ownerId = requireText(userId, 'userId');
  if (typeof store?.read === 'function') {
    const data = fileCollection(await store.read());
    return Object.values(data.setBinders)
      .filter((row) => row.userId === ownerId && row.status === 'tracked')
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
      .map(publicBinder);
  }
  if (typeof store?.pool !== 'function') return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT id,set_id,status,created_at,updated_at
    FROM fatedrop_collection_set_binders
    WHERE user_id=$1 AND status='tracked'
    ORDER BY updated_at DESC`, [ownerId]);
  return rows.map((row) => publicBinder({
    id: row.id,
    setId: row.set_id,
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function setCollectionSetBinderTrackedInStore(store, {
  userId,
  setId,
  tracked = true,
} = {}) {
  const ownerId = requireText(userId, 'userId');
  const canonicalSetId = requireText(setId, 'setId');
  const set = await getVerifiedCardSetFromStore(store, canonicalSetId);
  if (!set) {
    const error = new Error('Verified set identity is not available');
    error.code = 'SET_IDENTITY_NOT_VERIFIED';
    throw error;
  }
  const id = binderId(ownerId, canonicalSetId);
  const now = Date.now();
  const status = tracked === false ? 'removed' : 'tracked';

  if (typeof store?.mutate === 'function') {
    return store.mutate((state) => {
      const data = fileCollection(state);
      const previous = data.setBinders[id];
      const next = {
        id,
        userId: ownerId,
        setId: canonicalSetId,
        status,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      data.setBinders[id] = next;
      return Object.freeze({ ...publicBinder(next), set });
    });
  }
  if (typeof store?.pool !== 'function') throw new Error('Collection binder persistence is unavailable');
  const pool = await store.pool();
  const { rows } = await pool.query(`INSERT INTO fatedrop_collection_set_binders
    (id,user_id,set_id,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$5)
    ON CONFLICT (user_id,set_id) DO UPDATE
    SET status=EXCLUDED.status,updated_at=EXCLUDED.updated_at
    RETURNING id,set_id,status,created_at,updated_at`, [id, ownerId, canonicalSetId, status, now]);
  const row = rows[0];
  return Object.freeze({
    ...publicBinder({
      id: row.id,
      setId: row.set_id,
      status: row.status,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }),
    set,
  });
}
