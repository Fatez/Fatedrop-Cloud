function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

function amountMinor(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('amountMinor must be a non-negative safe integer');
  return n;
}

function timestamp(value, field) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${field} must be a non-negative integer timestamp`);
  return n;
}

export function normalizeCollectionCostBasis(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('cost basis is required');
  const currencyCode = requireText(input.currencyCode,'currencyCode').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError('currencyCode must be ISO-style 3-letter code');
  const priceScope = requireText(input.priceScope,'priceScope').toLowerCase();
  if (!['unit','lot'].includes(priceScope)) throw new TypeError('priceScope must be unit or lot');
  return Object.freeze({
    amountMinor: amountMinor(input.amountMinor),
    currencyCode,
    priceScope,
    acquiredAt: timestamp(input.acquiredAt,'acquiredAt'),
    sourceName: optionalText(input.sourceName)?.toLowerCase() ?? null,
  });
}

async function ownsActiveFileItem(store,userId,itemId) {
  const state = await store.read();
  const data = state.traderCollection;
  const item = data?.items?.[itemId];
  if (!item || item.status === 'removed') return false;
  return data.collections?.[item.collectionId]?.userId === userId;
}

async function ownsActivePostgresItem(store,userId,itemId) {
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT i.id FROM fatedrop_collection_items i
    JOIN fatedrop_collections c ON c.id=i.collection_id
    WHERE i.id=$1 AND c.user_id=$2 AND i.status='active'`,[itemId,userId]);
  return Boolean(rows[0]);
}

export async function upsertCollectionCostBasis(store,{userId,itemId,input}) {
  const ownerId = requireText(userId,'userId');
  const ownedItemId = requireText(itemId,'itemId');
  const normalized = normalizeCollectionCostBasis(input);
  const now = Date.now();

  if (typeof store?.mutate === 'function' && typeof store?.read === 'function') {
    if (!await ownsActiveFileItem(store,ownerId,ownedItemId)) return null;
    return store.mutate((state)=>{
      state.traderCollection.costBasis ||= {};
      const existing = state.traderCollection.costBasis[ownedItemId];
      const value = { collectionItemId:ownedItemId,...normalized,createdAt:existing?.createdAt ?? now,updatedAt:now };
      state.traderCollection.costBasis[ownedItemId] = value;
      return Object.freeze({...value});
    });
  }

  if (typeof store?.pool !== 'function') throw new Error('Collection cost-basis persistence is unavailable');
  if (!await ownsActivePostgresItem(store,ownerId,ownedItemId)) return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`INSERT INTO fatedrop_collection_item_cost_basis
    (collection_item_id,amount_minor,currency_code,price_scope,acquired_at,source_name,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (collection_item_id) DO UPDATE SET amount_minor=EXCLUDED.amount_minor,currency_code=EXCLUDED.currency_code,price_scope=EXCLUDED.price_scope,acquired_at=EXCLUDED.acquired_at,source_name=EXCLUDED.source_name,updated_at=EXCLUDED.updated_at
    RETURNING collection_item_id,amount_minor,currency_code,price_scope,acquired_at,source_name,created_at,updated_at`,
  [ownedItemId,normalized.amountMinor,normalized.currencyCode,normalized.priceScope,normalized.acquiredAt,normalized.sourceName,now]);
  const row = rows[0];
  return Object.freeze({
    collectionItemId:row.collection_item_id,
    amountMinor:Number(row.amount_minor),
    currencyCode:row.currency_code,
    priceScope:row.price_scope,
    acquiredAt:row.acquired_at == null ? null : Number(row.acquired_at),
    sourceName:row.source_name,
    createdAt:Number(row.created_at),
    updatedAt:Number(row.updated_at),
  });
}

export async function getCollectionCostBasis(store,{userId,itemId}) {
  const ownerId = requireText(userId,'userId');
  const ownedItemId = requireText(itemId,'itemId');
  if (typeof store?.read === 'function') {
    if (!await ownsActiveFileItem(store,ownerId,ownedItemId)) return null;
    const state = await store.read();
    const value = state.traderCollection?.costBasis?.[ownedItemId];
    return value ? Object.freeze({...value}) : null;
  }
  if (typeof store?.pool !== 'function') return null;
  if (!await ownsActivePostgresItem(store,ownerId,ownedItemId)) return null;
  const pool = await store.pool();
  const { rows } = await pool.query(`SELECT collection_item_id,amount_minor,currency_code,price_scope,acquired_at,source_name,created_at,updated_at
    FROM fatedrop_collection_item_cost_basis WHERE collection_item_id=$1`,[ownedItemId]);
  if (!rows[0]) return null;
  const row=rows[0];
  return Object.freeze({collectionItemId:row.collection_item_id,amountMinor:Number(row.amount_minor),currencyCode:row.currency_code,priceScope:row.price_scope,acquiredAt:row.acquired_at==null?null:Number(row.acquired_at),sourceName:row.source_name,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at)});
}
