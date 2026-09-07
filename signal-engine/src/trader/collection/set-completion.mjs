import { createHash, randomUUID } from 'node:crypto';

import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { getVerifiedCardSetFromStore, listVerifiedCardsFromStore } from '../catalogue/store.mjs';
import { computeCollectionSetProgress } from './set-progress.mjs';
import { listCollectionItemsFromStore } from './store.mjs';

const ACTIVE = 'active';
const SOURCE = 'user_confirmed_checklist';
const SCOPE = 'printing';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function assertionId(userId, setId) {
  return `fdsetcompletion_${digest(`${userId}|${setId}`).slice(0, 24)}`;
}

function eventId() {
  return `fdsetcompletionevent_${randomUUID().replaceAll('-', '')}`;
}

function collectionState(state) {
  state.traderCollection ||= {
    collections: {},
    items: {},
    grading: {},
    media: {},
    wants: {},
    events: [],
  };
  state.traderCollection.setCompletionAssertions ||= {};
  state.traderCollection.setCompletionEvents ||= [];
  return state.traderCollection;
}

function frozenPrintingIds(value) {
  return Object.freeze([
    ...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean)),
  ].sort());
}

function publicAssertion(row) {
  if (!row) return null;
  const printingIds = frozenPrintingIds(row.printingIds);
  return Object.freeze({
    id: row.id,
    setId: row.setId,
    active: row.status === ACTIVE,
    status: row.status,
    checklistScope: row.checklistScope,
    assertedPrintingCount: printingIds.length,
    printingIds,
    catalogueFingerprint: row.catalogueFingerprint,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function assertionFromDb(row) {
  if (!row) return null;
  return publicAssertion({
    id: row.id,
    setId: row.set_id,
    status: row.status,
    checklistScope: row.checklist_scope,
    printingIds: row.printing_ids,
    catalogueFingerprint: row.catalogue_fingerprint,
    source: row.source,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

function taggedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function publicSet(set) {
  return Object.freeze({
    id: set.id,
    name: set.name ?? null,
    tcgCode: set.tcgCode ?? null,
  });
}

function completionToken({ userId, setId, catalogueFingerprint, printingIdsToConfirm }) {
  const state = JSON.stringify({
    contractVersion: 1,
    userId,
    setId,
    catalogueFingerprint,
    printingIdsToConfirm,
  });
  return `fdsetcomplete_v1_${digest(state).slice(0, 48)}`;
}

function canonicalPrintingIdsForSet(setId, canonicalCards) {
  return frozenPrintingIds(canonicalCards
    .filter((card) => card?.verificationStatus === 'verified' && String(card.setId || '') === setId)
    .map((card) => card.printingId));
}

export function buildSetCompletionPreview({
  userId,
  set,
  canonicalCards,
  collectionItems,
  assertion = null,
  preferredLanguageCode = 'en',
  preferredVariantCode = 'standard',
} = {}) {
  const ownerId = requireText(userId, 'userId');
  if (!set || typeof set !== 'object') throw new TypeError('set is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');
  const setId = requireText(set.id, 'set.id');
  const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards });
  if (catalogue.status !== 'complete') {
    throw taggedError(
      'SET_CHECKLIST_UNAVAILABLE',
      'This set cannot be marked complete until its verified checklist is complete.',
      catalogue,
    );
  }

  const cataloguePrintingIds = canonicalPrintingIdsForSet(setId, canonicalCards);
  const assertedPrintingIds = assertion?.active === true ? frozenPrintingIds(assertion.printingIds) : Object.freeze([]);
  const progress = computeCollectionSetProgress({
    set,
    canonicalCards,
    collectionItems,
    assertedPrintingIds,
    preferredLanguageCode,
    preferredVariantCode,
  });
  const printingIdsToConfirm = frozenPrintingIds(progress.missingCards.map((card) => card.printingId));
  const catalogueFingerprint = digest(JSON.stringify({ setId, printingIds: cataloguePrintingIds }));
  const confirmationToken = completionToken({
    userId: ownerId,
    setId,
    catalogueFingerprint,
    printingIdsToConfirm,
  });

  return Object.freeze({
    contractVersion: 1,
    mode: 'preview_only',
    set: publicSet(set),
    catalogue,
    progress,
    action: Object.freeze({
      printingCount: printingIdsToConfirm.length,
      createsExactCardItems: false,
      changesCollectionValue: false,
      defaultQuantity: 1,
      copyState: 'raw',
      exactFinish: null,
      conditionCode: null,
    }),
    requiresUserConfirmation: printingIdsToConfirm.length > 0,
    confirmationToken,
    truth: Object.freeze({
      ownershipScope: 'verified_printing_checklist',
      valuationPolicy: 'exact_identity_only',
      message: 'Binder completion is recorded without inventing a finish, condition, or market value.',
    }),
    _plan: Object.freeze({ cataloguePrintingIds, printingIdsToConfirm, catalogueFingerprint }),
  });
}

export async function listSetCompletionAssertionsFromStore(store, { userId, setIds = null } = {}) {
  const ownerId = requireText(userId, 'userId');
  const wanted = Array.isArray(setIds)
    ? new Set(setIds.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  if (typeof store?.read === 'function') {
    const data = collectionState(await store.read());
    return Object.values(data.setCompletionAssertions)
      .filter((row) => row.userId === ownerId && row.status === ACTIVE)
      .filter((row) => !wanted || wanted.has(row.setId))
      .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
      .map(publicAssertion);
  }
  if (typeof store?.pool !== 'function') return [];
  const pool = await store.pool();
  const values = [ownerId];
  const conditions = ["user_id=$1", "status='active'"];
  if (wanted) {
    values.push([...wanted]);
    conditions.push(`set_id=ANY($${values.length}::text[])`);
  }
  try {
    const { rows } = await pool.query(`SELECT id,set_id,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at
      FROM fatedrop_collection_set_completion_assertions
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC`, values);
    return rows.map(assertionFromDb);
  } catch (error) {
    if (error?.code === '42P01') return [];
    throw error;
  }
}

async function previewInputsFromStore(store, { userId, setId }) {
  const [set, canonicalCards, collectionItems, assertions] = await Promise.all([
    getVerifiedCardSetFromStore(store, setId),
    listVerifiedCardsFromStore(store, { setId, limit: 500 }),
    listCollectionItemsFromStore(store, { userId, limit: 2000 }),
    listSetCompletionAssertionsFromStore(store, { userId, setIds: [setId] }),
  ]);
  if (!set) throw taggedError('SET_IDENTITY_NOT_VERIFIED', 'Verified set identity is not available.');
  return { set, canonicalCards, collectionItems, assertion: assertions[0] ?? null };
}

export async function previewSetCompletionFromStore(store, {
  userId,
  setId,
  preferredLanguageCode = 'en',
  preferredVariantCode = 'standard',
} = {}) {
  const ownerId = requireText(userId, 'userId');
  const canonicalSetId = requireText(setId, 'setId');
  return buildSetCompletionPreview({
    userId: ownerId,
    ...(await previewInputsFromStore(store, { userId: ownerId, setId: canonicalSetId })),
    preferredLanguageCode,
    preferredVariantCode,
  });
}

function filePreview(state, { userId, setId, preferredLanguageCode, preferredVariantCode }) {
  const catalogue = state.traderCatalogue || {};
  const rawSet = catalogue.sets?.[setId];
  if (!rawSet || rawSet.verificationStatus !== 'verified') {
    throw taggedError('SET_IDENTITY_NOT_VERIFIED', 'Verified set identity is not available.');
  }
  const tcg = catalogue.tcgs?.[rawSet.tcgId];
  const set = {
    id: rawSet.id,
    name: rawSet.name,
    tcgCode: tcg?.code ?? null,
    printedTotal: rawSet.printedTotal ?? null,
    total: rawSet.total ?? null,
  };
  const canonicalCards = Object.values(catalogue.cards || {})
    .filter((card) => card?.setId === setId)
    .map((card) => {
      const printing = catalogue.printings?.[card.printingId];
      return {
        ...card,
        fateCardId: card.id,
        tcgCode: tcg?.code ?? null,
        setName: rawSet.name,
        name: printing?.name ?? null,
        rarity: printing?.rarity ?? null,
      };
    });
  const data = collectionState(state);
  const collectionIds = new Set(Object.values(data.collections).filter((row) => row.userId === userId).map((row) => row.id));
  const collectionItems = Object.values(data.items).filter((item) => collectionIds.has(item.collectionId));
  const assertion = publicAssertion(data.setCompletionAssertions[assertionId(userId, setId)]);
  return buildSetCompletionPreview({
    userId,
    set,
    canonicalCards,
    collectionItems,
    assertion,
    preferredLanguageCode,
    preferredVariantCode,
  });
}

function resultFor(plan, assertion, { duplicate, writesPerformed }) {
  const assertedProgress = writesPerformed
    ? Object.freeze({
      ...plan.progress,
      ownedCount: plan.progress.totalCount,
      userConfirmedCount: plan._plan.cataloguePrintingIds.length,
      exactIdentityConfirmationNeededCount: plan.progress.totalCount - plan.progress.exactOwnedCount,
      missingCount: 0,
      completionPercent: 100,
      missingCards: Object.freeze([]),
    })
    : plan.progress;
  return Object.freeze({
    contractVersion: 1,
    mode: 'confirmed_set_completion',
    confirmed: true,
    duplicate,
    writesPerformed,
    newlyConfirmedPrintingCount: writesPerformed ? plan._plan.printingIdsToConfirm.length : 0,
    set: plan.set,
    assertion,
    progress: assertedProgress,
    truth: plan.truth,
  });
}

function verifyConfirmation(plan, confirmationToken) {
  if (plan._plan.printingIdsToConfirm.length === 0) return 'duplicate';
  if (plan.confirmationToken !== confirmationToken) {
    throw taggedError(
      'SET_COMPLETION_PREVIEW_CHANGED',
      'The binder or verified checklist changed after this preview. Preview it again before confirming.',
    );
  }
  return 'write';
}

async function confirmFile(store, options) {
  return store.mutate((state) => {
    const plan = filePreview(state, options);
    if (verifyConfirmation(plan, options.confirmationToken) === 'duplicate') {
      const current = publicAssertion(collectionState(state).setCompletionAssertions[assertionId(options.userId, options.setId)]);
      return resultFor(plan, current, { duplicate: true, writesPerformed: false });
    }
    const data = collectionState(state);
    const id = assertionId(options.userId, options.setId);
    const now = Date.now();
    const previous = data.setCompletionAssertions[id] ?? null;
    const next = {
      id,
      userId: options.userId,
      setId: options.setId,
      status: ACTIVE,
      checklistScope: SCOPE,
      printingIds: [...plan._plan.cataloguePrintingIds],
      catalogueFingerprint: plan._plan.catalogueFingerprint,
      confirmationBatchKey: `set-complete:${digest(options.confirmationToken).slice(0, 32)}`,
      source: SOURCE,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    data.setCompletionAssertions[id] = next;
    data.setCompletionEvents.push({
      id: eventId(),
      assertionId: id,
      userId: options.userId,
      eventType: previous?.status === ACTIVE ? 'refreshed' : 'confirmed',
      before: previous,
      after: next,
      occurredAt: now,
    });
    return resultFor(plan, publicAssertion(next), { duplicate: false, writesPerformed: true });
  });
}

function dbSet(row) {
  return row ? {
    id: row.id,
    name: row.name,
    tcgCode: row.tcg_code,
    printedTotal: row.printed_total,
    total: row.total,
    verificationStatus: row.verification_status,
  } : null;
}

function dbCard(row) {
  return {
    id: row.id,
    fateCardId: row.id,
    tcgCode: row.tcg_code,
    setId: row.set_id,
    setName: row.set_name,
    printingId: row.printing_id,
    name: row.name,
    collectorNumber: row.collector_number,
    rarity: row.rarity,
    variantCode: row.variant_code,
    languageCode: row.language_code,
    verificationStatus: row.verification_status,
  };
}

async function postgresPreview(client, options) {
  const [setResult, cardResult, itemResult, assertionResult] = await Promise.all([
    client.query(`SELECT s.id,s.name,s.printed_total,s.total,s.verification_status,t.code AS tcg_code
      FROM fatedrop_card_sets s JOIN fatedrop_tcgs t ON t.id=s.tcg_id
      WHERE s.id=$1 AND s.verification_status='verified'`, [options.setId]),
    client.query(`SELECT c.id,c.set_id,c.printing_id,c.collector_number,c.variant_code,c.language_code,c.verification_status,
        p.name,p.rarity,s.name AS set_name,t.code AS tcg_code
      FROM fatedrop_card_identities c
      JOIN fatedrop_card_printings p ON p.id=c.printing_id
      JOIN fatedrop_card_sets s ON s.id=c.set_id
      JOIN fatedrop_tcgs t ON t.id=c.tcg_id
      WHERE c.set_id=$1 AND c.verification_status='verified' AND p.verification_status='verified' AND s.verification_status='verified'`, [options.setId]),
    client.query(`SELECT i.card_identity_id AS fate_card_id,i.quantity,i.copy_state,i.status
      FROM fatedrop_collection_items i
      JOIN fatedrop_collections co ON co.id=i.collection_id
      JOIN fatedrop_card_identities c ON c.id=i.card_identity_id
      WHERE co.user_id=$1 AND c.set_id=$2 AND i.status='active'`, [options.userId, options.setId]),
    client.query(`SELECT id,set_id,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at
      FROM fatedrop_collection_set_completion_assertions
      WHERE user_id=$1 AND set_id=$2 FOR UPDATE`, [options.userId, options.setId]),
  ]);
  const set = dbSet(setResult.rows[0]);
  if (!set) throw taggedError('SET_IDENTITY_NOT_VERIFIED', 'Verified set identity is not available.');
  return buildSetCompletionPreview({
    userId: options.userId,
    set,
    canonicalCards: cardResult.rows.map(dbCard),
    collectionItems: itemResult.rows.map((row) => ({
      fateCardId: row.fate_card_id,
      quantity: Number(row.quantity),
      copyState: row.copy_state,
      status: row.status,
    })),
    assertion: assertionFromDb(assertionResult.rows[0]),
    preferredLanguageCode: options.preferredLanguageCode,
    preferredVariantCode: options.preferredVariantCode,
  });
}

async function confirmPostgres(store, options) {
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`set-complete:${options.userId}:${options.setId}`]);
    const plan = await postgresPreview(client, options);
    if (verifyConfirmation(plan, options.confirmationToken) === 'duplicate') {
      await client.query('COMMIT');
      return resultFor(plan, null, { duplicate: true, writesPerformed: false });
    }
    const id = assertionId(options.userId, options.setId);
    const now = Date.now();
    const batchKey = `set-complete:${digest(options.confirmationToken).slice(0, 32)}`;
    const { rows } = await client.query(`INSERT INTO fatedrop_collection_set_completion_assertions
      (id,user_id,set_id,status,checklist_scope,printing_ids,catalogue_fingerprint,confirmation_batch_key,source,created_at,updated_at)
      VALUES ($1,$2,$3,'active',$4,$5::jsonb,$6,$7,$8,$9,$9)
      ON CONFLICT (user_id,set_id) DO UPDATE SET
        status='active',checklist_scope=EXCLUDED.checklist_scope,printing_ids=EXCLUDED.printing_ids,
        catalogue_fingerprint=EXCLUDED.catalogue_fingerprint,confirmation_batch_key=EXCLUDED.confirmation_batch_key,
        source=EXCLUDED.source,updated_at=EXCLUDED.updated_at
      RETURNING id,set_id,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at`,
    [id, options.userId, options.setId, SCOPE, JSON.stringify(plan._plan.cataloguePrintingIds), plan._plan.catalogueFingerprint, batchKey, SOURCE, now]);
    const assertion = assertionFromDb(rows[0]);
    await client.query(`INSERT INTO fatedrop_collection_set_completion_events
      (id,assertion_id,user_id,event_type,snapshot_json,occurred_at)
      VALUES ($1,$2,$3,'confirmed',$4::jsonb,$5)`,
    [eventId(), id, options.userId, JSON.stringify(assertion), now]);
    await client.query('COMMIT');
    return resultFor(plan, assertion, { duplicate: false, writesPerformed: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmSetCompletionFromStore(store, {
  userId,
  setId,
  confirmationToken,
  confirmed = false,
  preferredLanguageCode = 'en',
  preferredVariantCode = 'standard',
} = {}) {
  const options = {
    userId: requireText(userId, 'userId'),
    setId: requireText(setId, 'setId'),
    confirmationToken: requireText(confirmationToken, 'confirmationToken'),
    preferredLanguageCode,
    preferredVariantCode,
  };
  if (confirmed !== true) {
    throw taggedError('SET_COMPLETION_CONFIRMATION_REQUIRED', 'Explicit user confirmation is required before this checklist is completed.');
  }
  if (!/^fdsetcomplete_v1_[a-f0-9]{48}$/.test(options.confirmationToken)) {
    throw taggedError('SET_COMPLETION_PREVIEW_CHANGED', 'Preview this set again before confirming it.');
  }
  if (typeof store?.mutate === 'function' && typeof store?.read === 'function') return confirmFile(store, options);
  if (typeof store?.pool === 'function') return confirmPostgres(store, options);
  throw new Error('Set completion persistence is unavailable.');
}

export async function removeSetCompletionAssertionFromStore(store, { userId, setId } = {}) {
  const ownerId = requireText(userId, 'userId');
  const canonicalSetId = requireText(setId, 'setId');
  const id = assertionId(ownerId, canonicalSetId);
  const now = Date.now();
  if (typeof store?.mutate === 'function') {
    return store.mutate((state) => {
      const data = collectionState(state);
      const previous = data.setCompletionAssertions[id];
      if (!previous || previous.status !== ACTIVE) return Object.freeze({ removed: false, assertion: publicAssertion(previous) });
      const next = { ...previous, status: 'removed', updatedAt: now };
      data.setCompletionAssertions[id] = next;
      data.setCompletionEvents.push({ id: eventId(), assertionId: id, userId: ownerId, eventType: 'removed', before: previous, after: next, occurredAt: now });
      return Object.freeze({ removed: true, assertion: publicAssertion(next) });
    });
  }
  if (typeof store?.pool !== 'function') throw new Error('Set completion persistence is unavailable.');
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`set-complete:${ownerId}:${canonicalSetId}`]);
    const current = await client.query(`SELECT id,set_id,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at
      FROM fatedrop_collection_set_completion_assertions WHERE user_id=$1 AND set_id=$2 FOR UPDATE`, [ownerId, canonicalSetId]);
    const before = assertionFromDb(current.rows[0]);
    if (!before?.active) {
      await client.query('COMMIT');
      return Object.freeze({ removed: false, assertion: before });
    }
    const updated = await client.query(`UPDATE fatedrop_collection_set_completion_assertions
      SET status='removed',updated_at=$1 WHERE user_id=$2 AND set_id=$3
      RETURNING id,set_id,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at`, [now, ownerId, canonicalSetId]);
    const after = assertionFromDb(updated.rows[0]);
    await client.query(`INSERT INTO fatedrop_collection_set_completion_events
      (id,assertion_id,user_id,event_type,snapshot_json,occurred_at)
      VALUES ($1,$2,$3,'removed',$4::jsonb,$5)`, [eventId(), id, ownerId, JSON.stringify(after), now]);
    await client.query('COMMIT');
    return Object.freeze({ removed: true, assertion: after });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export const __test = Object.freeze({ assertionId, completionToken, verifyConfirmation });
