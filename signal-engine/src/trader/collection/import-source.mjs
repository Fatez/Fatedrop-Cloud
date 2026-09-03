import { createHash } from 'node:crypto';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

function optionalTimestamp(value, field) {
  if (value == null) return null;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError(`${field} must be a non-negative integer timestamp`);
  return timestamp;
}

function stableId(parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `fdcolsource_${digest}`;
}

export function normalizeCollectionImportSource(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('collection import source is required');
  const sourceName = requireText(input.sourceName, 'sourceName').toLowerCase();
  const sourceRecordKey = requireText(input.sourceRecordKey, 'sourceRecordKey');
  const importBatchKey = optionalText(input.importBatchKey);
  const observedAt = optionalTimestamp(input.observedAt, 'observedAt');
  return Object.freeze({ sourceName, sourceRecordKey, importBatchKey, observedAt });
}

export function makeCollectionItemSourceId(itemId, source) {
  const normalized = normalizeCollectionImportSource(source);
  return stableId([
    requireText(itemId, 'itemId'),
    normalized.sourceName,
    normalized.sourceRecordKey,
    normalized.importBatchKey ?? '',
  ]);
}

function sourceState(state) {
  state.traderCollection ||= { collections:{},items:{},grading:{},media:{},wants:{},events:[] };
  state.traderCollection.itemSources ||= {};
  return state.traderCollection;
}

async function ownsActiveFileItem(store, userId, itemId) {
  const data = sourceState(await store.read());
  const item = data.items[itemId];
  if (!item || item.status === 'removed') return false;
  return data.collections[item.collectionId]?.userId === userId;
}

async function ownsActivePostgresItem(store, userId, itemId) {
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT i.id
    FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    WHERE i.id=$1 AND c.user_id=$2 AND i.status='active'`, [itemId,userId]);
  return Boolean(rows[0]);
}

export async function recordCollectionItemImportSource(store, { userId, itemId, source }) {
  const ownerId = requireText(userId, 'userId');
  const ownedItemId = requireText(itemId, 'itemId');
  const normalized = normalizeCollectionImportSource(source);
  const id = makeCollectionItemSourceId(ownedItemId, normalized);
  const now = Date.now();

  if (typeof store?.mutate === 'function' && typeof store?.read === 'function') {
    if (!await ownsActiveFileItem(store, ownerId, ownedItemId)) return null;
    return store.mutate((state) => {
      const data = sourceState(state);
      const existing = data.itemSources[id];
      const entry = {
        id,
        collectionItemId:ownedItemId,
        ...normalized,
        createdAt:existing?.createdAt ?? now,
        updatedAt:now,
      };
      data.itemSources[id] = entry;
      return Object.freeze({ ...entry });
    });
  }

  if (typeof store?.pool !== 'function') throw new Error('Collection import-source persistence is unavailable');
  if (!await ownsActivePostgresItem(store, ownerId, ownedItemId)) return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`INSERT INTO fatedrop_collection_item_sources
    (id,collection_item_id,source_name,source_record_key,import_batch_key,observed_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (id) DO UPDATE SET observed_at=COALESCE(EXCLUDED.observed_at,fatedrop_collection_item_sources.observed_at),updated_at=EXCLUDED.updated_at
    RETURNING id,collection_item_id,source_name,source_record_key,import_batch_key,observed_at,created_at,updated_at`,
  [id,ownedItemId,normalized.sourceName,normalized.sourceRecordKey,normalized.importBatchKey,normalized.observedAt,now]);
  const row = rows[0];
  return Object.freeze({
    id:row.id,
    collectionItemId:row.collection_item_id,
    sourceName:row.source_name,
    sourceRecordKey:row.source_record_key,
    importBatchKey:row.import_batch_key,
    observedAt:row.observed_at == null ? null : Number(row.observed_at),
    createdAt:Number(row.created_at),
    updatedAt:Number(row.updated_at),
  });
}

export async function listCollectionItemImportSources(store, { userId, itemId }) {
  const ownerId = requireText(userId, 'userId');
  const ownedItemId = requireText(itemId, 'itemId');
  if (typeof store?.read === 'function') {
    if (!await ownsActiveFileItem(store, ownerId, ownedItemId)) return [];
    const data = sourceState(await store.read());
    return Object.values(data.itemSources)
      .filter((entry) => entry.collectionItemId === ownedItemId)
      .sort((a,b) => a.createdAt - b.createdAt)
      .map((entry) => Object.freeze({ ...entry }));
  }
  if (typeof store?.pool !== 'function') return [];
  if (!await ownsActivePostgresItem(store, ownerId, ownedItemId)) return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT id,collection_item_id,source_name,source_record_key,import_batch_key,observed_at,created_at,updated_at
    FROM fatedrop_collection_item_sources WHERE collection_item_id=$1 ORDER BY created_at,id`, [ownedItemId]);
  return rows.map((row) => Object.freeze({
    id:row.id,
    collectionItemId:row.collection_item_id,
    sourceName:row.source_name,
    sourceRecordKey:row.source_record_key,
    importBatchKey:row.import_batch_key,
    observedAt:row.observed_at == null ? null : Number(row.observed_at),
    createdAt:Number(row.created_at),
    updatedAt:Number(row.updated_at),
  }));
}
