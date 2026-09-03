import { createHash } from 'node:crypto';
import {
  makeCollectionEventId,
  makeCollectionId,
  makeCollectionItemId,
  normalizeCollectionItemInput,
  normalizeCollectionItemPatch,
} from '../model.mjs';
import {
  makeCollectionItemSourceId,
  normalizeCollectionImportSource,
} from '../import-source.mjs';
import { parseCollectrCsv } from './collectr-csv.mjs';
import { matchCollectionImportRowsFromStore } from './matcher.mjs';
import { planCollectionImportReconciliation } from './reconciliation.mjs';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function requireTimestamp(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${field} must be a non-negative integer timestamp`);
  return number;
}

function batchKey(csvText) {
  const normalized = String(csvText ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `collectr_${digest}`;
}

function sourcePayload(sourceRecordKey, importBatchKey, observedAt) {
  return normalizeCollectionImportSource({
    sourceName: 'collectr',
    sourceRecordKey,
    importBatchKey,
    observedAt,
  });
}

function publicSource(entry) {
  return Object.freeze({
    id: entry.id,
    collectionItemId: entry.collectionItemId,
    sourceName: entry.sourceName,
    sourceRecordKey: entry.sourceRecordKey,
    importBatchKey: entry.importBatchKey ?? null,
    observedAt: entry.observedAt ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function eventPayload(item, grading = null) {
  return {
    id:item.id,
    fateCardId:item.fateCardId,
    quantity:item.quantity,
    tradeQuantity:item.tradeQuantity,
    copyState:item.copyState,
    conditionCode:item.conditionCode ?? null,
    notes:item.notes ?? null,
    status:item.status,
    revision:item.revision,
    grading:grading ?? null,
  };
}

function fileCollectionState(state) {
  state.traderCollection ||= {
    collections:{},items:{},grading:{},media:{},wants:{},events:[],itemSources:{},
  };
  state.traderCollection.collections ||= {};
  state.traderCollection.items ||= {};
  state.traderCollection.grading ||= {};
  state.traderCollection.media ||= {};
  state.traderCollection.wants ||= {};
  state.traderCollection.events ||= [];
  state.traderCollection.itemSources ||= {};
  return state.traderCollection;
}

function fileExistingState(state, userId) {
  const data = fileCollectionState(state);
  const ownedCollections = new Set(
    Object.values(data.collections).filter((collection) => collection.userId === userId).map((collection) => collection.id),
  );
  const existingItems = Object.values(data.items)
    .filter((item) => ownedCollections.has(item.collectionId) && item.status !== 'removed')
    .map((item) => Object.freeze({ ...item, grading:data.grading[item.id] ?? null }));
  const activeItemIds = new Set(existingItems.map((item) => item.id));
  const existingSources = Object.values(data.itemSources)
    .filter((source) => activeItemIds.has(source.collectionItemId))
    .filter((source) => String(source.sourceName).toLowerCase() === 'collectr')
    .sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return { data, existingItems, existingSources };
}

function assertVerifiedFileCard(state, fateCardId) {
  const card = state.traderCatalogue?.cards?.[fateCardId];
  if (!card || card.verificationStatus !== 'verified' || !card.tcgId) {
    const error = new Error('Import card identity is no longer verified');
    error.code = 'CARD_IDENTITY_NOT_VERIFIED';
    throw error;
  }
  return card;
}

function upsertFileSource(data, { itemId, source, now }) {
  const id = makeCollectionItemSourceId(itemId, source);
  const existing = data.itemSources[id];
  const entry = {
    id,
    collectionItemId:itemId,
    ...source,
    createdAt:existing?.createdAt ?? now,
    updatedAt:now,
  };
  data.itemSources[id] = entry;
  return publicSource(entry);
}

function applyFile(store, { userId, matches, importBatchKey, observedAt }) {
  return store.mutate((state) => {
    const now = observedAt;
    const { data, existingItems, existingSources } = fileExistingState(state, userId);
    const plan = planCollectionImportReconciliation({
      sourceName:'collectr',
      matches,
      existingSources,
      existingItems,
    });
    const created=[];
    const updated=[];
    const unchanged=[];
    const provenance=[];

    for (const action of plan.creates) {
      const normalized = normalizeCollectionItemInput(action.collectionInput);
      const card = assertVerifiedFileCard(state, normalized.fateCardId);
      const collectionId = makeCollectionId(userId, card.tcgId);
      const existingCollection = data.collections[collectionId];
      if (existingCollection && existingCollection.userId !== userId) throw new Error('Collection ownership conflict');
      data.collections[collectionId] ||= {
        id:collectionId,userId,tcgId:card.tcgId,name:'My Collection',visibility:'private',createdAt:now,updatedAt:now,
      };

      const itemId = makeCollectionItemId();
      const item = {
        id:itemId,
        collectionId,
        fateCardId:normalized.fateCardId,
        quantity:normalized.quantity,
        tradeQuantity:normalized.tradeQuantity,
        copyState:normalized.copyState,
        conditionCode:normalized.conditionCode,
        notes:normalized.notes,
        status:'active',
        revision:1,
        createdAt:now,
        updatedAt:now,
      };
      data.items[itemId] = item;
      if (normalized.grading) data.grading[itemId] = normalized.grading;
      data.events.push({
        id:makeCollectionEventId(),userId,collectionItemId:itemId,eventType:'created',before:null,
        after:eventPayload(item,normalized.grading),occurredAt:now,
      });
      data.collections[collectionId].updatedAt = now;
      const source = sourcePayload(action.sourceRecordKey, importBatchKey, observedAt);
      provenance.push(upsertFileSource(data,{itemId,source,now}));
      created.push(Object.freeze({ itemId, fateCardId:item.fateCardId, quantity:item.quantity, sourceRecordKey:action.sourceRecordKey }));
    }

    for (const action of plan.updates) {
      const current = data.items[action.item.id];
      if (!current || current.status === 'removed') throw new Error('Import update item disappeared');
      if (data.collections[current.collectionId]?.userId !== userId) throw new Error('Collection ownership conflict');
      if (action.expectedRevision != null && Number(current.revision) !== Number(action.expectedRevision)) {
        const error = new Error('Collection item revision conflict during import');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      const before = { ...current };
      const normalized = normalizeCollectionItemPatch(action.patch, { ...current, grading:data.grading[current.id] ?? null });
      const next = {
        ...current,
        quantity:normalized.quantity,
        tradeQuantity:normalized.tradeQuantity,
        conditionCode:normalized.conditionCode,
        notes:normalized.notes,
        revision:Number(current.revision) + 1,
        updatedAt:now,
      };
      data.items[current.id] = next;
      data.events.push({
        id:makeCollectionEventId(),userId,collectionItemId:current.id,eventType:'updated',
        before:eventPayload(before,data.grading[current.id] ?? null),
        after:eventPayload(next,data.grading[current.id] ?? null),occurredAt:now,
      });
      data.collections[current.collectionId].updatedAt = now;
      const source = sourcePayload(action.sourceRecordKey ?? action.match?.row?.sourceRecordKey, importBatchKey, observedAt);
      provenance.push(upsertFileSource(data,{itemId:current.id,source,now}));
      updated.push(Object.freeze({ itemId:current.id, fateCardId:current.fateCardId, quantity:next.quantity, revision:next.revision, sourceRecordKey:source.sourceRecordKey }));
    }

    for (const action of plan.unchanged) {
      const item = data.items[action.item.id];
      if (!item || item.status === 'removed' || data.collections[item.collectionId]?.userId !== userId) {
        throw new Error('Import unchanged item disappeared');
      }
      const recordKey = action.match?.row?.sourceRecordKey ?? action.source?.sourceRecordKey;
      const source = sourcePayload(recordKey, importBatchKey, observedAt);
      provenance.push(upsertFileSource(data,{itemId:item.id,source,now}));
      unchanged.push(Object.freeze({ itemId:item.id, fateCardId:item.fateCardId, quantity:item.quantity, sourceRecordKey:source.sourceRecordKey }));
    }

    return Object.freeze({
      sourceName:'collectr',
      importBatchKey,
      mode:'confirmed',
      writesPerformed:created.length + updated.length > 0 || provenance.length > 0,
      summary:Object.freeze({
        created:created.length,
        updated:updated.length,
        unchanged:unchanged.length,
        held:plan.holds.length,
        staleSourceRecords:plan.staleSources.length,
      }),
      created:Object.freeze(created),
      updated:Object.freeze(updated),
      unchanged:Object.freeze(unchanged),
      holds:plan.holds,
      staleSources:plan.staleSources,
      provenance:Object.freeze(provenance),
    });
  });
}

function dbItem(row) {
  return Object.freeze({
    id:row.id,
    fateCardId:row.card_identity_id,
    quantity:Number(row.quantity),
    tradeQuantity:Number(row.trade_quantity),
    copyState:row.copy_state,
    conditionCode:row.condition_code,
    notes:row.notes,
    status:row.status,
    revision:Number(row.revision),
    grading:row.grading_company ? Object.freeze({
      gradingCompany:row.grading_company,
      gradeLabel:row.grade_label,
      gradeValue:row.grade_value == null ? null : Number(row.grade_value),
      certificationNumber:row.certification_number,
      certificationStatus:row.certification_status,
      verificationSource:row.verification_source,
      verifiedAt:row.verified_at == null ? null : Number(row.verified_at),
    }) : null,
  });
}

function dbSource(row) {
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

async function upsertPostgresSource(client, { itemId, source, now }) {
  const id = makeCollectionItemSourceId(itemId, source);
  const { rows } = await client.query(`INSERT INTO fatedrop_collection_item_sources
    (id,collection_item_id,source_name,source_record_key,import_batch_key,observed_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (id) DO UPDATE SET
      observed_at=COALESCE(EXCLUDED.observed_at,fatedrop_collection_item_sources.observed_at),
      updated_at=EXCLUDED.updated_at
    RETURNING id,collection_item_id,source_name,source_record_key,import_batch_key,observed_at,created_at,updated_at`,[
    id,itemId,source.sourceName,source.sourceRecordKey,source.importBatchKey,source.observedAt,now,
  ]);
  return dbSource(rows[0]);
}

async function applyPostgres(store, { userId, matches, importBatchKey, observedAt }) {
  const pool = await store.pool();
  const client = await pool.connect();
  const now = observedAt;
  try {
    await client.query('BEGIN');
    // Serialise Collectr refreshes per account while still allowing unrelated
    // collection edits/users to proceed. Item rows are also locked below so a
    // simultaneous manual edit cannot be silently overwritten.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[userId,'collectr']);

    const itemRows = await client.query(`SELECT i.*,g.grading_company,g.grade_label,g.grade_value,g.certification_number,
        g.certification_status,g.verification_source,g.verified_at
      FROM fatedrop_collection_items i
      JOIN fatedrop_collections c ON c.id=i.collection_id
      LEFT JOIN fatedrop_collection_grading g ON g.collection_item_id=i.id
      WHERE c.user_id=$1 AND i.status='active'
      ORDER BY i.id
      FOR UPDATE OF i`,[userId]);
    const existingItems = itemRows.rows.map(dbItem);
    const sourceRows = await client.query(`SELECT s.id,s.collection_item_id,s.source_name,s.source_record_key,s.import_batch_key,
        s.observed_at,s.created_at,s.updated_at
      FROM fatedrop_collection_item_sources s
      JOIN fatedrop_collection_items i ON i.id=s.collection_item_id
      JOIN fatedrop_collections c ON c.id=i.collection_id
      WHERE c.user_id=$1 AND i.status='active' AND LOWER(s.source_name)='collectr'
      ORDER BY s.created_at,s.id`,[userId]);
    const existingSources = sourceRows.rows.map(dbSource);
    const plan = planCollectionImportReconciliation({
      sourceName:'collectr',matches,existingSources,existingItems,
    });

    const requiredCardIds = [...new Set(plan.creates.map((action)=>action.collectionInput.fateCardId))];
    const cardsById = new Map();
    if (requiredCardIds.length) {
      const cardRows = await client.query(`SELECT c.id,c.tcg_id
        FROM fatedrop_card_identities c
        JOIN fatedrop_card_printings p ON p.id=c.printing_id
        JOIN fatedrop_card_sets s ON s.id=c.set_id
        WHERE c.id=ANY($1::text[])
          AND c.verification_status='verified'
          AND p.verification_status='verified'
          AND s.verification_status='verified'`,[requiredCardIds]);
      for (const row of cardRows.rows) cardsById.set(row.id,row);
      if (cardsById.size !== requiredCardIds.length) {
        const error = new Error('One or more import card identities are no longer verified');
        error.code = 'CARD_IDENTITY_NOT_VERIFIED';
        throw error;
      }
    }

    const created=[];
    const updated=[];
    const unchanged=[];
    const provenance=[];

    for (const action of plan.creates) {
      const normalized = normalizeCollectionItemInput(action.collectionInput);
      const card = cardsById.get(normalized.fateCardId);
      const collectionId = makeCollectionId(userId, card.tcg_id);
      await client.query(`INSERT INTO fatedrop_collections (id,user_id,tcg_id,name,visibility,created_at,updated_at)
        VALUES ($1,$2,$3,'My Collection','private',$4,$4)
        ON CONFLICT (user_id,tcg_id) DO UPDATE SET updated_at=GREATEST(fatedrop_collections.updated_at,EXCLUDED.updated_at)`,[
        collectionId,userId,card.tcg_id,now,
      ]);
      const itemId = makeCollectionItemId();
      await client.query(`INSERT INTO fatedrop_collection_items
        (id,collection_id,card_identity_id,quantity,trade_quantity,copy_state,condition_code,notes,status,revision,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',1,$9,$9)`,[
        itemId,collectionId,normalized.fateCardId,normalized.quantity,normalized.tradeQuantity,
        normalized.copyState,normalized.conditionCode,normalized.notes,now,
      ]);
      if (normalized.grading) {
        const g=normalized.grading;
        await client.query(`INSERT INTO fatedrop_collection_grading
          (collection_item_id,grading_company,grade_label,grade_value,certification_number,certification_status,verification_source,verified_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,[
          itemId,g.gradingCompany,g.gradeLabel,g.gradeValue,g.certificationNumber,g.certificationStatus,g.verificationSource,g.verifiedAt,now,
        ]);
      }
      const item = {id:itemId,fateCardId:normalized.fateCardId,quantity:normalized.quantity,tradeQuantity:normalized.tradeQuantity,copyState:normalized.copyState,conditionCode:normalized.conditionCode,notes:normalized.notes,status:'active',revision:1};
      await client.query(`INSERT INTO fatedrop_collection_item_events
        (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
        VALUES ($1,$2,$3,'created',NULL,$4::jsonb,$5)`,[
        makeCollectionEventId(),userId,itemId,JSON.stringify(eventPayload(item,normalized.grading)),now,
      ]);
      const source = sourcePayload(action.sourceRecordKey,importBatchKey,observedAt);
      provenance.push(await upsertPostgresSource(client,{itemId,source,now}));
      created.push(Object.freeze({itemId,fateCardId:item.fateCardId,quantity:item.quantity,sourceRecordKey:action.sourceRecordKey}));
    }

    for (const action of plan.updates) {
      const current = action.item;
      const normalized = normalizeCollectionItemPatch(action.patch,current);
      const nextRevision = Number(current.revision)+1;
      const result = await client.query(`UPDATE fatedrop_collection_items i
        SET quantity=$1,trade_quantity=$2,condition_code=$3,notes=$4,revision=$5,updated_at=$6
        FROM fatedrop_collections c
        WHERE i.id=$7 AND i.collection_id=c.id AND c.user_id=$8 AND i.status='active' AND i.revision=$9`,[
        normalized.quantity,normalized.tradeQuantity,normalized.conditionCode,normalized.notes,nextRevision,now,current.id,userId,current.revision,
      ]);
      if (result.rowCount !== 1) {
        const error = new Error('Collection item revision conflict during import');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      const after = {...current,quantity:normalized.quantity,tradeQuantity:normalized.tradeQuantity,conditionCode:normalized.conditionCode,notes:normalized.notes,revision:nextRevision};
      await client.query(`INSERT INTO fatedrop_collection_item_events
        (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
        VALUES ($1,$2,$3,'updated',$4::jsonb,$5::jsonb,$6)`,[
        makeCollectionEventId(),userId,current.id,JSON.stringify(eventPayload(current,current.grading)),JSON.stringify(eventPayload(after,current.grading)),now,
      ]);
      const recordKey = action.match?.row?.sourceRecordKey ?? action.source?.sourceRecordKey;
      const source = sourcePayload(recordKey,importBatchKey,observedAt);
      provenance.push(await upsertPostgresSource(client,{itemId:current.id,source,now}));
      updated.push(Object.freeze({itemId:current.id,fateCardId:current.fateCardId,quantity:normalized.quantity,revision:nextRevision,sourceRecordKey:source.sourceRecordKey}));
    }

    for (const action of plan.unchanged) {
      const recordKey = action.match?.row?.sourceRecordKey ?? action.source?.sourceRecordKey;
      const source = sourcePayload(recordKey,importBatchKey,observedAt);
      provenance.push(await upsertPostgresSource(client,{itemId:action.item.id,source,now}));
      unchanged.push(Object.freeze({itemId:action.item.id,fateCardId:action.item.fateCardId,quantity:action.item.quantity,sourceRecordKey:source.sourceRecordKey}));
    }

    await client.query('COMMIT');
    return Object.freeze({
      sourceName:'collectr',importBatchKey,mode:'confirmed',
      writesPerformed:created.length + updated.length > 0 || provenance.length > 0,
      summary:Object.freeze({created:created.length,updated:updated.length,unchanged:unchanged.length,held:plan.holds.length,staleSourceRecords:plan.staleSources.length}),
      created:Object.freeze(created),updated:Object.freeze(updated),unchanged:Object.freeze(unchanged),
      holds:plan.holds,staleSources:plan.staleSources,provenance:Object.freeze(provenance),
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    if (error?.code === '42P01') {
      const wrapped = new Error('Collectr confirm persistence schema is not deployed');
      wrapped.code = 'COLLECTR_CONFIRM_SCHEMA_MISSING';
      throw wrapped;
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Re-parse and re-match the user-supplied export at confirmation time. The
 * client never submits a trusted reconciliation plan. Exact safe rows are
 * applied atomically; review/ambiguous rows are retained as holds, and stale
 * source records are reported without deleting collection ownership.
 */
export async function confirmCollectrImportFromStore(store, {
  userId,
  csvText,
  observedAt = Date.now(),
} = {}) {
  const ownerId = requireText(userId,'userId');
  const rawCsv = requireText(csvText,'csvText');
  const effectiveObservedAt = requireTimestamp(observedAt,'observedAt');
  const parsed = parseCollectrCsv(rawCsv);
  const matched = await matchCollectionImportRowsFromStore(store,{rows:parsed.rows});
  const importBatchKey = batchKey(rawCsv);
  const options = {userId:ownerId,matches:matched.matches,importBatchKey,observedAt:effectiveObservedAt};
  const applied = typeof store?.mutate === 'function'
    ? await applyFile(store,options)
    : typeof store?.pool === 'function'
      ? await applyPostgres(store,options)
      : (()=>{throw new Error('Collection persistence is unavailable');})();

  return Object.freeze({
    ...applied,
    parsed:Object.freeze({acceptedRows:parsed.rows.length,rejectedRows:parsed.rejected.length,rejected:parsed.rejected}),
    matched:matched.summary,
  });
}
