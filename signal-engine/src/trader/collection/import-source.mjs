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

function publicSource(row) {
  return Object.freeze({
    id:row.id,
    collectionItemId:row.collection_item_id ?? row.collectionItemId,
    sourceName:row.source_name ?? row.sourceName,
    sourceRecordKey:row.source_record_key ?? row.sourceRecordKey,
    importBatchKey:row.import_batch_key ?? row.importBatchKey ?? null,
    observedAt:(row.observed_at ?? row.observedAt) == null ? null : Number(row.observed_at ?? row.observedAt),
    createdAt:Number(row.created_at ?? row.createdAt),
    updatedAt:Number(row.updated_at ?? row.updatedAt),
  });
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
  return publicSource(rows[0]);
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
      .map(publicSource);
  }
  if (typeof store?.pool !== 'function') return [];
  if (!await ownsActivePostgresItem(store, ownerId, ownedItemId)) return [];
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT id,collection_item_id,source_name,source_record_key,import_batch_key,observed_at,created_at,updated_at
    FROM fatedrop_collection_item_sources WHERE collection_item_id=$1 ORDER BY created_at,id`, [ownedItemId]);
  return rows.map(publicSource);
}

export async function listCollectionImportSourcesFromStore(store, { userId, sourceName = null } = {}) {
  const ownerId = requireText(userId,'userId');
  const wantedSource = optionalText(sourceName)?.toLowerCase() ?? null;
  if (typeof store?.read === 'function') {
    const data = sourceState(await store.read());
    const ownedCollections = new Set(Object.values(data.collections).filter((collection)=>collection.userId === ownerId).map((collection)=>collection.id));
    const activeItemIds = new Set(Object.values(data.items)
      .filter((item)=>item.status !== 'removed' && ownedCollections.has(item.collectionId))
      .map((item)=>item.id));
    return Object.values(data.itemSources)
      .filter((entry)=>activeItemIds.has(entry.collectionItemId))
      .filter((entry)=>!wantedSource || String(entry.sourceName).toLowerCase() === wantedSource)
      .sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id))
      .map(publicSource);
  }
  if (typeof store?.pool !== 'function') return [];
  const pool=await store.pool();
  const values=[ownerId];
  let sourceClause='';
  if (wantedSource) { values.push(wantedSource); sourceClause=` AND LOWER(s.source_name)=$${values.length}`; }
  const { rows }=await pool.query(`SELECT s.id,s.collection_item_id,s.source_name,s.source_record_key,s.import_batch_key,s.observed_at,s.created_at,s.updated_at
    FROM fatedrop_collection_item_sources s
    JOIN fatedrop_collection_items i ON i.id=s.collection_item_id
    JOIN fatedrop_collections c ON c.id=i.collection_id
    WHERE c.user_id=$1 AND i.status='active'${sourceClause}
    ORDER BY s.created_at,s.id`,values);
  return rows.map(publicSource);
}
