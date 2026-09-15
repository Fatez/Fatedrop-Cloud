import { createHash, randomUUID } from 'node:crypto';

import { assessCanonicalSetCompleteness } from '../catalogue/completeness.mjs';
import { getVerifiedCardSetFromStore, listVerifiedCardsFromStore, listVerifiedPrintingsFromStore } from '../catalogue/store.mjs';
import { filterCollectionEligibleCardsFromStore } from './catalogue-eligibility.mjs';
import { computeCollectionSetProgress } from './set-progress.mjs';
import { listCollectionItemsFromStore } from './store.mjs';
import { makeCollectionEventId, makeCollectionId, makeCollectionItemId } from './model.mjs';
import { makeFateTcgId } from '../card-identity.mjs';
import { requireEditionForSet } from '../catalogue/set-edition-policy.mjs';

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

function assertionId(userId, setId, editionCode = 'standard') {
  return `fdsetcompletion_${digest(`${userId}|${setId}|${editionCode}`).slice(0, 24)}`;
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
    editionCode: row.editionCode ?? 'unspecified',
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
    editionCode: row.edition_code ?? 'unspecified',
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
    tcgId: set.tcgId ?? null,
    tcgCode: set.tcgCode ?? null,
  });
}

function completionToken({ userId, setId, editionCode, catalogueFingerprint, printingIdsToConfirm, cardIdentityIdsToAdd }) {
  const state = JSON.stringify({
    contractVersion: 1,
    userId,
    setId,
    editionCode,
    catalogueFingerprint,
    printingIdsToConfirm,
    cardIdentityIdsToAdd,
  });
  return `fdsetcomplete_v1_${digest(state).slice(0, 48)}`;
}

function canonicalPrintingIdsForSet(setId, canonicalCards, canonicalPrintings = null) {
  if (canonicalPrintings != null) {
    return frozenPrintingIds(canonicalPrintings
      .filter((printing) => printing?.verificationStatus === 'verified' && String(printing.setId || '') === setId)
      .map((printing) => printing.printingId ?? printing.id));
  }
  return frozenPrintingIds(canonicalCards
    .filter((card) => card?.verificationStatus === 'verified' && String(card.setId || '') === setId)
    .map((card) => card.printingId));
}

export function buildSetCompletionPreview({
  userId,
  set,
  canonicalCards,
  canonicalPrintings = null,
  collectionItems,
  assertion = null,
  editionCode = null,
  preferredLanguageCode = 'en',
  preferredVariantCode = 'standard',
} = {}) {
  const ownerId = requireText(userId, 'userId');
  if (!set || typeof set !== 'object') throw new TypeError('set is required');
  if (!Array.isArray(canonicalCards)) throw new TypeError('canonicalCards must be an array');
  if (canonicalPrintings != null && !Array.isArray(canonicalPrintings)) throw new TypeError('canonicalPrintings must be an array when provided');
  if (!Array.isArray(collectionItems)) throw new TypeError('collectionItems must be an array');
  const setId = requireText(set.id, 'set.id');
  const edition = requireEditionForSet(set, editionCode);
  const catalogue = assessCanonicalSetCompleteness({ set, canonicalCards, canonicalPrintings });
  if (catalogue.status !== 'complete') {
    throw taggedError(
      'SET_CHECKLIST_UNAVAILABLE',
      'This set cannot be marked complete until its verified checklist is complete.',
      catalogue,
    );
  }

  const cataloguePrintingIds = canonicalPrintingIdsForSet(setId, canonicalCards, canonicalPrintings);
  // Completion now materializes exact collection items. Legacy printing-only
  // assertions must not hide the exact cards that still need to be created.
  const assertedPrintingIds = Object.freeze([]);
  const progress = computeCollectionSetProgress({
    set,
    canonicalCards,
    canonicalPrintings,
    collectionItems,
    assertedPrintingIds,
    editionCode: edition,
    preferredLanguageCode,
    preferredVariantCode,
  });
  const printingIdsToConfirm = frozenPrintingIds(progress.missingCards.map((card) => card.printingId));
  const unresolved = progress.missingCards.filter((card) => !card.fateCardId);
  if (unresolved.length) {
    throw taggedError(
      'SET_EXACT_CHECKLIST_UNAVAILABLE',
      'This set cannot be added to the collection until every checklist slot has one verified exact card identity.',
      { setId, unresolvedPrintingIds: unresolved.map((card) => card.printingId) },
    );
  }
  const cardIdentityIdsToAdd = Object.freeze(progress.missingCards.map((card) => card.fateCardId));
  const catalogueFingerprint = digest(JSON.stringify({
    setId,
    editionCode: edition,
    printingIds: cataloguePrintingIds,
    cardIdentityIds: cardIdentityIdsToAdd,
  }));
  const confirmationToken = completionToken({
    userId: ownerId,
    setId,
    editionCode: edition,
    catalogueFingerprint,
    printingIdsToConfirm,
    cardIdentityIdsToAdd,
  });

  return Object.freeze({
    contractVersion: 1,
    mode: 'preview_only',
    set: Object.freeze({ ...publicSet(set), editionCode: edition }),
    catalogue,
    progress,
    action: Object.freeze({
      printingCount: printingIdsToConfirm.length,
      createsExactCardItems: true,
      changesCollectionValue: true,
      defaultQuantity: 1,
      copyState: 'raw',
      exactFinish: 'verified_regular_identity',
      conditionCode: 'unknown',
    }),
    requiresUserConfirmation: printingIdsToConfirm.length > 0,
    confirmationToken,
    truth: Object.freeze({
      ownershipScope: 'verified_exact_regular_identity',
      valuationPolicy: 'exact_identity_only',
      message: 'One verified exact raw card is added for each missing checklist slot. Existing copies are never duplicated.',
    }),
    _plan: Object.freeze({ cataloguePrintingIds, printingIdsToConfirm, cardIdentityIdsToAdd, catalogueFingerprint }),
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
    const { rows } = await pool.query(`SELECT id,set_id,edition_code,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at
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
  const [set, rawCanonicalCards, canonicalPrintings, collectionItems, assertions] = await Promise.all([
    getVerifiedCardSetFromStore(store, setId),
    listVerifiedCardsFromStore(store, { setId, limit: 500 }),
    listVerifiedPrintingsFromStore(store, { setId, limit: 1000 }),
    listCollectionItemsFromStore(store, { userId, limit: 2000 }),
    listSetCompletionAssertionsFromStore(store, { userId, setIds: [setId] }),
  ]);
  if (!set) throw taggedError('SET_IDENTITY_NOT_VERIFIED', 'Verified set identity is not available.');
  const canonicalCards = await filterCollectionEligibleCardsFromStore(store, rawCanonicalCards);
  return { set, canonicalCards, canonicalPrintings, collectionItems, assertions, assertion: assertions[0] ?? null };
}

export async function previewSetCompletionFromStore(store, {
  userId,
  setId,
  editionCode = null,
  preferredLanguageCode = 'en',
  preferredVariantCode = 'standard',
} = {}) {
  const ownerId = requireText(userId, 'userId');
  const canonicalSetId = requireText(setId, 'setId');
  const inputs = await previewInputsFromStore(store, { userId: ownerId, setId: canonicalSetId });
  const edition = requireEditionForSet(inputs.set, editionCode);
  return buildSetCompletionPreview({
    userId: ownerId,
    ...inputs,
    assertion: inputs.assertions?.find((row) => row.editionCode === edition) ?? null,
    editionCode: edition,
    preferredLanguageCode,
    preferredVariantCode,
  });
}

function filePreview(state, { userId, setId, editionCode, preferredLanguageCode, preferredVariantCode }) {
  const catalogue = state.traderCatalogue || {};
  const rawSet = catalogue.sets?.[setId];
  if (!rawSet || rawSet.verificationStatus !== 'verified') {
    throw taggedError('SET_IDENTITY_NOT_VERIFIED', 'Verified set identity is not available.');
  }
  const tcg = catalogue.tcgs?.[rawSet.tcgId];
  const set = {
    id: rawSet.id,
    code: rawSet.code,
    name: rawSet.name,
    tcgId: rawSet.tcgId,
    tcgCode: tcg?.code ?? null,
    printedTotal: rawSet.printedTotal ?? null,
    total: rawSet.total ?? null,
  };
  const canonicalPrintings = Object.values(catalogue.printings || {})
    .filter((printing) => printing?.setId === setId && printing.verificationStatus === 'verified')
    .map((printing) => ({ ...printing, printingId: printing.id, setName: rawSet.name, tcgCode: tcg?.code ?? null }));
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
  const edition = requireEditionForSet(set, editionCode);
  const assertion = publicAssertion(data.setCompletionAssertions[assertionId(userId, setId, edition)]);
  return buildSetCompletionPreview({
    userId,
    set,
    canonicalCards,
    canonicalPrintings,
    collectionItems,
    assertion,
    editionCode: edition,
    preferredLanguageCode,
    preferredVariantCode,
  });
}

function resultFor(plan, assertion, { duplicate, writesPerformed, createdCardItemCount = 0 }) {
  const assertedProgress = writesPerformed
    ? Object.freeze({
      ...plan.progress,
      ownedCount: plan.progress.totalCount,
      userConfirmedCount: plan._plan.cataloguePrintingIds.length,
      exactOwnedCount: plan.progress.totalCount,
      exactIdentityConfirmationNeededCount: 0,
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
    createdCardItemCount,
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
      const current = publicAssertion(collectionState(state).setCompletionAssertions[assertionId(options.userId, options.setId, plan.set.editionCode)]);
      return resultFor(plan, current, { duplicate: true, writesPerformed: false });
    }
    const data = collectionState(state);
    const id = assertionId(options.userId, options.setId, plan.set.editionCode);
    const now = Date.now();
    const previous = data.setCompletionAssertions[id] ?? null;
    const next = {
      id,
      userId: options.userId,
      setId: options.setId,
      editionCode: plan.set.editionCode,
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
    const rawSet = state.traderCatalogue.sets[options.setId];
    const collectionId = makeCollectionId(options.userId, rawSet.tcgId);
    data.collections[collectionId] ||= {
      id: collectionId,
      userId: options.userId,
      tcgId: rawSet.tcgId,
      name: 'My Collection',
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    };
    for (const fateCardId of plan._plan.cardIdentityIdsToAdd) {
      const itemId = makeCollectionItemId();
      const item = {
        id: itemId,
        collectionId,
        fateCardId,
        quantity: 1,
        tradeQuantity: 0,
        copyState: 'raw',
        conditionCode: 'unknown',
        notes: null,
        status: ACTIVE,
        revision: 1,
        grading: null,
        createdAt: now,
        updatedAt: now,
      };
      data.items[itemId] = item;
      data.events.push({
        id: makeCollectionEventId(),
        userId: options.userId,
        collectionItemId: itemId,
        eventType: 'created',
        before: null,
        after: item,
        occurredAt: now,
      });
    }
    data.setCompletionEvents.push({
      id: eventId(),
      assertionId: id,
      userId: options.userId,
      eventType: previous?.status === ACTIVE ? 'refreshed' : 'confirmed',
      before: previous,
      after: next,
      occurredAt: now,
    });
    return resultFor(plan, publicAssertion(next), {
      duplicate: false,
      writesPerformed: true,
      createdCardItemCount: plan._plan.cardIdentityIdsToAdd.length,
    });
  });
}

function dbSet(row) {
  return row ? {
    id: row.id,
    code: row.code,
    name: row.name,
    tcgId: row.tcg_id,
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
  const [setResult, cardResult, printingResult, itemResult, assertionResult] = await Promise.all([
    client.query(`SELECT s.id,s.code,s.name,s.tcg_id,s.printed_total,s.total,s.verification_status,t.code AS tcg_code
      FROM fatedrop_card_sets s JOIN fatedrop_tcgs t ON t.id=s.tcg_id
      WHERE s.id=$1 AND s.verification_status='verified'`, [options.setId]),
    client.query(`SELECT c.id,c.set_id,c.printing_id,c.collector_number,c.variant_code,c.language_code,c.verification_status,
        p.name,p.rarity,s.name AS set_name,t.code AS tcg_code
      FROM fatedrop_card_identities c
      JOIN fatedrop_card_printings p ON p.id=c.printing_id
      JOIN fatedrop_card_sets s ON s.id=c.set_id
      JOIN fatedrop_tcgs t ON t.id=c.tcg_id
      LEFT JOIN fatedrop_variant_resolution_state rs ON rs.card_identity_id=c.id
      WHERE c.set_id=$1 AND c.verification_status='verified' AND p.verification_status='verified' AND s.verification_status='verified'
        AND (rs.classifier_state IS NULL OR rs.classifier_state NOT IN ('INVALID_CATALOGUE_ENTRY','UNRESOLVED_EVIDENCE'))`, [options.setId]),
    client.query(`SELECT p.id,p.set_id,p.collector_number,p.printing_code,p.name,p.rarity,p.supertype,p.verification_status,p.verified_at,
        s.name AS set_name,t.code AS tcg_code
      FROM fatedrop_card_printings p
      JOIN fatedrop_card_sets s ON s.id=p.set_id
      JOIN fatedrop_tcgs t ON t.id=p.tcg_id
      WHERE p.set_id=$1 AND p.verification_status='verified' AND s.verification_status='verified'`, [options.setId]),
    client.query(`SELECT i.card_identity_id AS fate_card_id,i.quantity,i.copy_state,i.status
      FROM fatedrop_collection_items i
      JOIN fatedrop_collections co ON co.id=i.collection_id
      JOIN fatedrop_card_identities c ON c.id=i.card_identity_id
      WHERE co.user_id=$1 AND c.set_id=$2 AND i.status='active'`, [options.userId, options.setId]),
    client.query(`SELECT id,set_id,edition_code,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at
      FROM fatedrop_collection_set_completion_assertions
      WHERE user_id=$1 AND set_id=$2 AND edition_code=$3 FOR UPDATE`, [options.userId, options.setId, options.editionCode]),
  ]);
  const set = dbSet(setResult.rows[0]);
  if (!set) throw taggedError('SET_IDENTITY_NOT_VERIFIED', 'Verified set identity is not available.');
  return buildSetCompletionPreview({
    userId: options.userId,
    set,
    canonicalCards: cardResult.rows.map(dbCard),
    canonicalPrintings: printingResult.rows.map((row) => ({ id: row.id, printingId: row.id, setId: row.set_id, setName: row.set_name, tcgCode: row.tcg_code, collectorNumber: row.collector_number, printingCode: row.printing_code, name: row.name, rarity: row.rarity, supertype: row.supertype, verificationStatus: row.verification_status, verifiedAt: row.verified_at == null ? null : Number(row.verified_at) })),
    collectionItems: itemResult.rows.map((row) => ({
      fateCardId: row.fate_card_id,
      quantity: Number(row.quantity),
      copyState: row.copy_state,
      status: row.status,
    })),
    assertion: assertionFromDb(assertionResult.rows[0]),
    editionCode: options.editionCode,
    preferredLanguageCode: options.preferredLanguageCode,
    preferredVariantCode: options.preferredVariantCode,
  });
}

async function confirmPostgres(store, options) {
  const pool = await store.pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`set-complete:${options.userId}:${options.setId}:${options.editionCode}`]);
    const plan = await postgresPreview(client, options);
    if (verifyConfirmation(plan, options.confirmationToken) === 'duplicate') {
      await client.query('COMMIT');
      return resultFor(plan, null, { duplicate: true, writesPerformed: false });
    }
    const id = assertionId(options.userId, options.setId, plan.set.editionCode);
    const now = Date.now();
    const batchKey = `set-complete:${digest(options.confirmationToken).slice(0, 32)}`;
    const { rows } = await client.query(`INSERT INTO fatedrop_collection_set_completion_assertions
      (id,user_id,set_id,edition_code,status,checklist_scope,printing_ids,catalogue_fingerprint,confirmation_batch_key,source,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'active',$5,$6::jsonb,$7,$8,$9,$10,$10)
      ON CONFLICT (user_id,set_id,edition_code) DO UPDATE SET
        status='active',checklist_scope=EXCLUDED.checklist_scope,printing_ids=EXCLUDED.printing_ids,
        catalogue_fingerprint=EXCLUDED.catalogue_fingerprint,confirmation_batch_key=EXCLUDED.confirmation_batch_key,
        source=EXCLUDED.source,updated_at=EXCLUDED.updated_at
      RETURNING id,set_id,edition_code,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at`,
    [id, options.userId, options.setId, plan.set.editionCode, SCOPE, JSON.stringify(plan._plan.cataloguePrintingIds), plan._plan.catalogueFingerprint, batchKey, SOURCE, now]);
    const assertion = assertionFromDb(rows[0]);
    const tcgId = plan.set.tcgId ?? makeFateTcgId(plan.set.tcgCode);
    const collectionId = makeCollectionId(options.userId, tcgId);
    await client.query(`INSERT INTO fatedrop_collections (id,user_id,tcg_id,name,visibility,created_at,updated_at)
      VALUES ($1,$2,$3,'My Collection','private',$4,$4)
      ON CONFLICT (user_id,tcg_id) DO UPDATE
      SET updated_at=GREATEST(fatedrop_collections.updated_at,EXCLUDED.updated_at)`,
    [collectionId, options.userId, tcgId, now]);
    for (const fateCardId of plan._plan.cardIdentityIdsToAdd) {
      const itemId = makeCollectionItemId();
      const item = {
        id: itemId,
        fateCardId,
        quantity: 1,
        tradeQuantity: 0,
        copyState: 'raw',
        conditionCode: 'unknown',
        notes: null,
        status: ACTIVE,
        revision: 1,
      };
      await client.query(`INSERT INTO fatedrop_collection_items
        (id,collection_id,card_identity_id,quantity,trade_quantity,copy_state,condition_code,notes,status,revision,created_at,updated_at)
        VALUES ($1,$2,$3,1,0,'raw','unknown',NULL,'active',1,$4,$4)`, [itemId, collectionId, fateCardId, now]);
      await client.query(`INSERT INTO fatedrop_collection_item_events
        (id,user_id,collection_item_id,event_type,before_json,after_json,occurred_at)
        VALUES ($1,$2,$3,'created',NULL,$4::jsonb,$5)`,
      [makeCollectionEventId(), options.userId, itemId, JSON.stringify(item), now]);
    }
    await client.query(`INSERT INTO fatedrop_collection_set_completion_events
      (id,assertion_id,user_id,event_type,snapshot_json,occurred_at)
      VALUES ($1,$2,$3,'confirmed',$4::jsonb,$5)`,
    [eventId(), id, options.userId, JSON.stringify(assertion), now]);
    await client.query('COMMIT');
    return resultFor(plan, assertion, {
      duplicate: false,
      writesPerformed: true,
      createdCardItemCount: plan._plan.cardIdentityIdsToAdd.length,
    });
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
  editionCode = 'standard',
  confirmationToken,
  confirmed = false,
  preferredLanguageCode = 'en',
  preferredVariantCode = 'standard',
} = {}) {
  const options = {
    userId: requireText(userId, 'userId'),
    setId: requireText(setId, 'setId'),
    editionCode: requireText(editionCode, 'editionCode').toLowerCase(),
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

export async function removeSetCompletionAssertionFromStore(store, { userId, setId, editionCode = 'standard' } = {}) {
  const ownerId = requireText(userId, 'userId');
  const canonicalSetId = requireText(setId, 'setId');
  const edition = requireText(editionCode, 'editionCode').toLowerCase();
  const id = assertionId(ownerId, canonicalSetId, edition);
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
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`set-complete:${ownerId}:${canonicalSetId}:${edition}`]);
    const current = await client.query(`SELECT id,set_id,edition_code,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at
      FROM fatedrop_collection_set_completion_assertions WHERE user_id=$1 AND set_id=$2 AND edition_code=$3 FOR UPDATE`, [ownerId, canonicalSetId, edition]);
    const before = assertionFromDb(current.rows[0]);
    if (!before?.active) {
      await client.query('COMMIT');
      return Object.freeze({ removed: false, assertion: before });
    }
    const updated = await client.query(`UPDATE fatedrop_collection_set_completion_assertions
      SET status='removed',updated_at=$1 WHERE user_id=$2 AND set_id=$3 AND edition_code=$4
      RETURNING id,set_id,edition_code,status,checklist_scope,printing_ids,catalogue_fingerprint,source,created_at,updated_at`, [now, ownerId, canonicalSetId, edition]);
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
